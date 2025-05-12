  // src/server.ts
  import express from 'express';
  import http from 'http';
  import WebSocket from 'ws';
  import path from 'path';
  import fs from 'fs';
  import { AddressInfo } from 'net';
  import { inspect } from 'util';

  function log(level: 'INFO'|'ERROR'|'DEBUG'|'WARN', message: string, data?: any): void {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] [${level}] ${message}`);
    if (data) console.log(inspect(data, { depth: null, colors: true }));
  }

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
      log('INFO', `WebSocket server initializing`);
      
      this.wss.on('connection', (ws: WebSocket, req: http.IncomingMessage) => {
        const clientIp = req.socket.remoteAddress;
        const extWs = ws as ExtendedWebSocket;
        extWs.isAlive = true;
        
        // Enhanced connection logging
        const isPublisher = req.headers['x-device-type'] === 'arduino-publisher';
        extWs.type = isPublisher ? ClientType.PUBLISHER : ClientType.SUBSCRIBER;
        
        log('INFO', `New connection from ${clientIp}`, {
          type: extWs.type,
          headers: req.headers,
          url: req.url
        });

        if (isPublisher) {
          if (this.publisher) {
            log('WARN', 'Disconnecting previous publisher', {
              wasConnectedFor: `${Date.now() - (this.publisher as any).connectedAt}ms`
            });
            try {
              this.publisher.close(1000, 'New publisher connected');
            } catch (error) {
              log('ERROR', 'Error closing previous publisher', error);
            }
          }
          
          (extWs as any).connectedAt = Date.now();
          this.publisher = extWs;
          log('INFO', 'Publisher connected (Arduino)', { clientIp });
        } else {
          this.subscribers.push(extWs);
          log('INFO', `Subscriber connected - Total: ${this.subscribers.length}`, { clientIp });
          
          if (Object.keys(this.latestData).length > 0) {
            log('DEBUG', 'Sending latest data to new subscriber', this.latestData);
            try {
              extWs.send(JSON.stringify(this.latestData));
            } catch (error) {
              log('ERROR', 'Failed to send initial data to subscriber', error);
            }
          }
        }

        extWs.on('pong', () => {
          log('DEBUG', `Received pong from client ${clientIp}`, { type: extWs.type });
          extWs.isAlive = true;
        });

        extWs.on('message', (message: WebSocket.Data) => {
          try {
            log('DEBUG', `Raw message received from ${extWs.type}`, { 
              message: message.toString(), 
              clientIp 
            });
            
            const data = JSON.parse(message.toString());
            log('INFO', `Parsed data from ${extWs.type}`, data);
            
            if (isPublisher && 'C' in data) {
              log('INFO', 'Valid sensor data received, broadcasting');
              this.broadcastToSubscribers(data);
            } else if (!isPublisher && data.type === 'control') {
              log('INFO', 'Control message received from subscriber', data);
              // Control message logic
            } else {
              log('WARN', 'Received message with unexpected format', { data, clientType: extWs.type });
            }
          } catch (error) {
            log('ERROR', `Failed to process message: ${message}`, error);
          }
        });

        extWs.on('close', (code: number, reason: string) => {
          log('INFO', `WebSocket closed`, { 
            clientIp, 
            type: extWs.type, 
            code, 
            reason 
          });
          
          if (isPublisher) {
            if (this.publisher === extWs) {
              this.publisher = null;
              log('INFO', 'Publisher disconnected', { code, reason });
            }
          } else {
            const index = this.subscribers.indexOf(extWs);
            if (index !== -1) {
              this.subscribers.splice(index, 1);
              log('INFO', `Subscriber disconnected - Remaining: ${this.subscribers.length}`, { code, reason });
            }
          }
        });

        extWs.on('error', (error) => {
          log('ERROR', `WebSocket error for ${extWs.type}`, {
            clientIp,
            error: error.message,
            stack: error.stack
          });
        });
      });

      // Set up ping interval with better logging
      const pingInterval = setInterval(() => {
        log('DEBUG', `Running ping check. Active connections: ${this.wss.clients.size}`);
        
        this.wss.clients.forEach((ws) => {
          const extWs = ws as ExtendedWebSocket;
          if (!extWs.isAlive) {
            log('WARN', `Terminating inactive connection`, { type: extWs.type });
            return ws.terminate();
          }
          
          extWs.isAlive = false;
          try {
            log('DEBUG', `Sending ping to ${extWs.type}`);
            extWs.ping();
          } catch (error) {
            log('ERROR', `Failed to ping client`, { type: extWs.type, error });
            ws.terminate();
          }
        });
        
        // Check for missing publisher
        if (!this.publisher) {
          log('DEBUG', 'No publisher connected');
        }
      }, 30000);
      
      // Clean up interval on server close
      this.wss.on('close', () => {
        log('INFO', 'WebSocket server closing');
        clearInterval(pingInterval);
      });
    }

    private broadcastToSubscribers(data: SensorData): void {
      this.latestData = data;
      
      if (this.subscribers.length === 0) {
        log('WARN', 'No active subscribers to receive data');
        return;
      }
      
      log('INFO', `Broadcasting data to ${this.subscribers.length} subscribers`, data);
      
      const jsonData = JSON.stringify(data);
      const subscribers = [...this.subscribers];
      let successCount = 0;
      let failCount = 0;
      
      for (const subscriber of subscribers) {
        try {
          subscriber.send(jsonData);
          successCount++;
        } catch (error) {
          failCount++;
          log('ERROR', `Failed to send data to subscriber`, error);
          
          const index = this.subscribers.indexOf(subscriber);
          if (index !== -1) {
            this.subscribers.splice(index, 1);
            log('INFO', `Removed problematic subscriber - Remaining: ${this.subscribers.length}`);
          }
        }
      }
      
      log('INFO', `Broadcast complete: ${successCount} successful, ${failCount} failed`);
    }

    public start(): void {
      this.server.listen(this.port, () => {
        const address = this.server.address() as AddressInfo;
        log('INFO', `Server started on port ${address.port}`, {
          port: address.port,
          subscribers: this.subscribers.length,
          publisher: this.publisher ? 'connected' : 'disconnected'
        });
      });
    }
  }

  // Start the server
  const server = new WaterMonitorServer();
  server.start();