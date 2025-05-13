import express from "express";
import http from "http";
import WebSocket from "ws";
import path from "path";
import fs from "fs";
import { AddressInfo } from "net";

// Configure logging
function log(level: string, message: string, data?: any): void {
   const timestamp = new Date().toISOString();
   console.log(`[${timestamp}] [${level}] ${message}`);
   if (data) console.log(JSON.stringify(data, null, 2));
}

// Data interface
interface SensorData {
   C?: number;
   PH?: number;
   T?: number;
   [key: string]: any;
}

// WebSocket connection with metadata
interface ExtendedWebSocket extends WebSocket {
   isAlive: boolean;
   isPublisher: boolean;
   id: string;
}

// Main server class
class WaterMonitorServer {
   private app: express.Application;
   private server: http.Server;
   private wss: WebSocket.Server;
   private subscribers: ExtendedWebSocket[] = [];
   private publisher: ExtendedWebSocket | null = null;
   private latestData: SensorData = {};
   private port: number;

   constructor() {
      this.port = parseInt(process.env.PORT || "10000", 10);
      this.app = express();
      this.server = http.createServer(this.app);
      this.wss = new WebSocket.Server({ server: this.server });

      this.setupExpress();
      this.setupWebSocketServer();
   }

   private setupExpress(): void {
      // CORS middleware
      this.app.use((req, res, next) => {
         res.header("Access-Control-Allow-Origin", "*");
         res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
         next();
      });

      // Serve static files
      const staticPath = path.join(__dirname, "../static");
      if (fs.existsSync(staticPath)) {
         this.app.use("/static", express.static(staticPath));
      }

      // Root endpoint - serve HTML client
      this.app.get("/", (req, res) => {
         const htmlPath = path.join(__dirname, "../static/index.html");
         if (fs.existsSync(htmlPath)) {
            res.sendFile(htmlPath);
         } else {
            res.send("<h1>Water Quality Monitor API</h1><p>WebSocket server is running.</p>");
         }
      });

      // Health check endpoint for Render
      this.app.get("/health", (req, res) => {
         res.json({
            status: "healthy",
            subscribers: this.subscribers.length,
            publisher: this.publisher ? "connected" : "disconnected",
         });
      });
   }

   private setupWebSocketServer(): void {
      log("INFO", "WebSocket server initializing");

      this.wss.on("connection", (ws: WebSocket, req: http.IncomingMessage) => {
         const extWs = ws as ExtendedWebSocket;
         extWs.isAlive = true;
         extWs.isPublisher = false;
         extWs.id = this.generateId();

         const clientIp = req.socket.remoteAddress || "unknown";
         log("INFO", `New WebSocket connection from ${clientIp}`, { id: extWs.id });

         // Handle incoming messages
         extWs.on("message", (message: WebSocket.Data) => {
            try {
               const msgStr = message.toString();
               log("DEBUG", `Received message: ${msgStr}`);

               // Parse as JSON
               try {
                  const data = JSON.parse(msgStr);

                  // Handle registration message
                  if (data.type === "register") {
                     this.handleRegistration(extWs, data.role, clientIp);
                     return;
                  }

                  // Handle sensor data from publisher
                  if (extWs.isPublisher && data.C !== undefined) {
                     log("INFO", "Received sensor data from publisher", data);
                     this.latestData = data;
                     this.broadcastToSubscribers(data);
                     return;
                  }

                  log("WARN", "Unhandled message type", { data });
               } catch (e) {
                  // Handle ping message (simple string)
                  if (msgStr === "ping") {
                     extWs.send("pong");
                     return;
                  }

                  log("ERROR", "Failed to parse message as JSON", { error: (e as Error).message, raw: msgStr });
               }
            } catch (error) {
               log("ERROR", "Error handling message", { error: (error as Error).message });
            }
         });

         // Handle connection close
         extWs.on("close", () => {
            if (extWs.isPublisher && this.publisher === extWs) {
               log("INFO", "Publisher disconnected");
               this.publisher = null;
            } else {
               this.subscribers = this.subscribers.filter((sub) => sub !== extWs);
               log("INFO", `Subscriber disconnected, remaining: ${this.subscribers.length}`);
            }
         });

         // Handle errors
         extWs.on("error", (err) => {
            log("ERROR", "WebSocket error", { id: extWs.id, error: err.message });
         });

         // Send initial ping to verify connection
         extWs.send("connected");
      });

      // Setup ping interval to keep connections alive
      setInterval(() => {
         this.wss.clients.forEach((ws) => {
            const extWs = ws as ExtendedWebSocket;

            if (!extWs.isAlive) {
               log("WARN", "Terminating inactive connection", { id: extWs.id });
               return ws.terminate();
            }

            extWs.isAlive = false;
            try {
               extWs.send("ping");
            } catch (e) {
               log("ERROR", "Failed to ping client", { id: extWs.id, error: (e as Error).message });
               ws.terminate();
            }
         });
      }, 30000);
   }

   private handleRegistration(ws: ExtendedWebSocket, role: string, clientIp: string): void {
      if (role === "publisher") {
         // If there's an existing publisher, disconnect it
         if (this.publisher) {
            log("WARN", "Replacing existing publisher", { oldId: this.publisher.id, newId: ws.id });
            try {
               this.publisher.send(JSON.stringify({ type: "disconnect", reason: "new-publisher" }));
            } catch (e) {
               log("ERROR", "Error notifying old publisher", { error: (e as Error).message });
            }
         }

         ws.isPublisher = true;
         this.publisher = ws;
         log("INFO", "Publisher registered", { id: ws.id, ip: clientIp });

         // Confirm registration
         ws.send(JSON.stringify({ type: "registered", role: "publisher" }));
      } else {
         // Register as subscriber
         this.subscribers.push(ws);
         log("INFO", `Subscriber registered, total: ${this.subscribers.length}`, { id: ws.id, ip: clientIp });

         // Confirm registration
         ws.send(JSON.stringify({ type: "registered", role: "subscriber" }));

         // Send latest data if available
         if (Object.keys(this.latestData).length > 0) {
            ws.send(JSON.stringify({ type: "data", ...this.latestData }));
         }
      }
   }

   private broadcastToSubscribers(data: SensorData): void {
      if (this.subscribers.length === 0) {
         log("WARN", "No subscribers to broadcast to");
         return;
      }

      log("INFO", `Broadcasting to ${this.subscribers.length} subscribers`, data);

      const message = JSON.stringify({ type: "data", ...data });
      let failedCount = 0;

      this.subscribers.forEach((client) => {
         try {
            client.send(message);
         } catch (e) {
            failedCount++;
            log("ERROR", "Failed to send to subscriber", { id: client.id, error: (e as Error).message });
         }
      });

      // Clean up failed connections
      this.subscribers = this.subscribers.filter((sub) => sub.readyState === WebSocket.OPEN);

      if (failedCount > 0) {
         log("WARN", `Failed to send to ${failedCount} subscribers, cleaned up connections`);
      }
   }

   private generateId(): string {
      return Math.random().toString(36).substring(2, 15);
   }

   public start(): void {
      this.server.listen(this.port, () => {
         const address = this.server.address() as AddressInfo;
         log("INFO", `Server started on port ${address.port}`);
      });
   }
}

// Start server
const server = new WaterMonitorServer();
server.start();
