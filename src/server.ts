// src/server.ts
import express from 'express';
import http from 'http';
import WebSocket from 'ws';
import path from 'path';
import fs from 'fs';
import { AddressInfo } from 'net';

// Define interface for data structure
interface SensorData {
  C?: number;
  PH?: number;
  T?: number;
  [key: string]: any;
}

// WebSocket client types
enum ClientType {
  PUBLISHER = 'publisher',
  SUBSCRIBER = 'subscriber'
}

// WebSocket connection with metadata
interface ExtendedWebSocket extends WebSocket {
  isAlive: boolean;
  type: ClientType;
}

// Main application class
class WaterMonitorServer {
  private app: express.Application;
  private server: http.Server;
  private wss: WebSocket.Server;
  private subscribers: ExtendedWebSocket[] = [];
  private publisher: ExtendedWebSocket | null = null;
  private latestData: SensorData = {};
  private port: number;

  constructor() {
    this.port = parseInt(process.env.PORT || '8081', 10);
    this.app = express();
    this.server = http.createServer(this.app);
    this.wss = new WebSocket.Server({ server: this.server });
    
    this.setupExpress();
    this.setupWebSocketServer();
  }

  private setupExpress(): void {
    // CORS middleware
    this.app.use((req, res, next) => {
      res.header('Access-Control-Allow-Origin', '*');
      res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
      next();
    });

    // Serve static files if directory exists
    const staticPath = path.join(process.cwd(), 'static');
    if (fs.existsSync(staticPath)) {
      this.app.use('/static', express.static(staticPath));
    }

    // Root endpoint
    this.app.get('/', (req, res) => {
      const htmlPath = path.join(process.cwd(), 'static', 'ws-client.html');
      if (fs.existsSync(htmlPath)) {
        res.sendFile(htmlPath);
      } else {
        res.json({ message: 'Monitor de Calidad de Agua API' });
      }
    });

    // Health check endpoint
    this.app.get('/health', (req, res) => {
      res.json({
        status: 'healthy',
        subscribers: this.subscribers.length,
        publisher: this.publisher ? 'connected' : 'disconnected'
      });
    });
  }

  private setupWebSocketServer(): void {
    // WebSocket connection handler
    this.wss.on('connection', (ws: WebSocket, req: http.IncomingMessage) => {
      const extWs = ws as ExtendedWebSocket;
      extWs.isAlive = true;
      
      // Determine client type (publisher or subscriber)
      const isPublisher = req.headers['x-device-type'] === 'arduino-publisher';
      extWs.type = isPublisher ? ClientType.PUBLISHER : ClientType.SUBSCRIBER;

      if (isPublisher) {
        // If a publisher connects, disconnect the previous one
        if (this.publisher) {
          try {
            this.publisher.close(1000, 'New publisher connected');
          } catch (error) {
            console.error('Error closing previous publisher:', error);
          }
        }
        
        this.publisher = extWs;
        console.log('Nuevo PUBLISHER conectado (Arduino)');
      } else {
        this.subscribers.push(extWs);
        console.log(`Nuevo SUBSCRIBER conectado - Total: ${this.subscribers.length}`);
        
        // Send latest data to new subscriber if available
        if (Object.keys(this.latestData).length > 0) {
          extWs.send(JSON.stringify(this.latestData));
        }
      }

      // Handle pong messages to check connection liveliness
      extWs.on('pong', () => {
        extWs.isAlive = true;
      });

      // Handle incoming messages
      extWs.on('message', (message: WebSocket.Data) => {
        try {
          const data = JSON.parse(message.toString());
          console.log(`Datos recibidos: ${JSON.stringify(data)}`);
          
          // If from publisher and has 'C' field, broadcast to all subscribers
          if (isPublisher && 'C' in data) {
            this.broadcastToSubscribers(data);
          } 
          // Handle control messages from subscribers
          else if (!isPublisher && data.type === 'control') {
            // Implement control message logic if needed
          }
        } catch (error) {
          console.error(`Error: Datos no válidos: ${message}`);
        }
      });

      // Handle WebSocket closure
      extWs.on('close', () => {
        if (isPublisher) {
          if (this.publisher === extWs) {
            this.publisher = null;
            console.log('Publisher desconectado');
          }
        } else {
          const index = this.subscribers.indexOf(extWs);
          if (index !== -1) {
            this.subscribers.splice(index, 1);
            console.log(`Subscriber desconectado - Quedan: ${this.subscribers.length}`);
          }
        }
      });

      // Handle WebSocket errors
      extWs.on('error', (error) => {
        console.error(`Error en WebSocket: ${error.message}`);
      });
    });

    // Set up ping interval to check for disconnected clients
    setInterval(() => {
      this.wss.clients.forEach((ws) => {
        const extWs = ws as ExtendedWebSocket;
        if (!extWs.isAlive) {
          return ws.terminate();
        }
        
        extWs.isAlive = false;
        try {
          extWs.ping();
        } catch (error) {
          // Handle ping error - client might be disconnected
          ws.terminate();
        }
      });
    }, 30000); // Check every 30 seconds
  }

  private broadcastToSubscribers(data: SensorData): void {
    this.latestData = data;
    
    if (this.subscribers.length === 0) {
      console.log('No hay subscribers activos');
      return;
    }
    
    console.log(`Enviando datos a ${this.subscribers.length} subscribers`);
    
    const jsonData = JSON.stringify(data);
    const subscribers = [...this.subscribers]; // Create a copy for safe iteration
    
    for (const subscriber of subscribers) {
      try {
        subscriber.send(jsonData);
      } catch (error) {
        console.error(`Error al enviar datos: ${error}`);
        // Remove problematic subscribers
        const index = this.subscribers.indexOf(subscriber);
        if (index !== -1) {
          this.subscribers.splice(index, 1);
        }
      }
    }
  }

  public start(): void {
    this.server.listen(this.port, () => {
      const address = this.server.address() as AddressInfo;
      console.log(`Servidor iniciado en http://localhost:${address.port}`);
    });
  }
}

// Start the server
const server = new WaterMonitorServer();
server.start();