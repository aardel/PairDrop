import express from "express";
import RateLimit from "express-rate-limit";
import {fileURLToPath} from "url";
import path, {dirname} from "path";
import http from "http";
import multer from "multer";
import PrinterService from "./printer-service.js";

export default class PairDropServer {

    constructor(conf) {
        const app = express();

        // Initialize printer service
        this._printerService = new PrinterService(conf);

        // Setup multer for file uploads (in-memory storage)
        const storage = multer.memoryStorage();
        const maxFileSize = parseInt(process.env.PRINT_MAX_FILE_SIZE) || (100 * 1024 * 1024); // Default 100MB
        const upload = multer({
            storage: storage,
            limits: {
                fileSize: maxFileSize
            }
        });

        if (conf.rateLimit) {
            const limiter = RateLimit({
                windowMs: 5 * 60 * 1000, // 5 minutes
                max: 1000, // Limit each IP to 1000 requests per `window` (here, per 5 minutes)
                message: 'Too many requests from this IP Address, please try again after 5 minutes.',
                standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
                legacyHeaders: false, // Disable the `X-RateLimit-*` headers
            })

            app.use(limiter);
            // ensure correct client ip and not the ip of the reverse proxy is used for rate limiting
            // see https://express-rate-limit.mintlify.app/guides/troubleshooting-proxy-issues

            app.set('trust proxy', conf.rateLimit);

            if (!conf.debugMode) {
                console.log("Use DEBUG_MODE=true to find correct number for RATE_LIMIT.");
            }
        }

        const __filename = fileURLToPath(import.meta.url);
        const __dirname = dirname(__filename);

        const publicPathAbs = path.join(__dirname, '../public');
        app.use(express.static(publicPathAbs));
        
        // Add JSON body parser for printer endpoints
        app.use(express.json());

        if (conf.debugMode && conf.rateLimit) {
            console.debug("\n");
            console.debug("----DEBUG RATE_LIMIT----")
            console.debug("To find out the correct value for RATE_LIMIT go to '/ip' and ensure the returned IP-address is the IP-address of your client.")
            console.debug("See https://github.com/express-rate-limit/express-rate-limit#troubleshooting-proxy-issues for more info")
            app.get('/ip', (req, res) => {
                res.send(req.ip);
            })
        }

        // By default, clients connecting to your instance use the signaling server of your instance to connect to other devices.
        // By using `WS_SERVER`, you can host an instance that uses another signaling server.
        app.get('/config', (req, res) => {
            res.send({
                signalingServer: conf.signalingServer,
                buttons: conf.buttons
            });
        });

        // Printer API endpoints
        app.get('/api/printers', (req, res) => {
            if (!this._printerService.isEnabled()) {
                return res.status(503).json({ error: 'Printer service is not enabled' });
            }
            const printers = this._printerService.getOnlinePrinters();
            res.json({ printers });
        });

        app.post('/api/print', upload.single('file'), async (req, res) => {
            try {
                if (!this._printerService.isEnabled()) {
                    return res.status(503).json({ error: 'Printer service is not enabled' });
                }

                const { printerId } = req.body;
                const file = req.file;

                if (!printerId || !file) {
                    return res.status(400).json({ error: 'Missing printerId or file' });
                }

                const printer = this._printerService.getPrinter(printerId);
                if (!printer) {
                    return res.status(404).json({ error: 'Printer not found' });
                }

                console.log('Print job:', file.originalname, '->', printer.name);

                // Parse print options
                const options = {
                    copies: parseInt(req.body.copies) || 1,
                    sides: req.body.sides || 'one-sided',
                    colorMode: req.body.colorMode || 'auto',
                    mimeType: file.mimetype
                };

                const result = await this._printerService.submitPrintJob(
                    printerId,
                    file.buffer,
                    file.originalname,
                    options
                );

                res.json(result);
            } catch (error) {
                console.error('Print job error:', error);
                res.status(500).json({ error: error.message });
            }
        });

        app.use((req, res) => {
            res.redirect(301, '/');
        });

        app.get('/', (req, res) => {
            res.sendFile('index.html');
            console.log(`Serving client files from:\n${publicPathAbs}`)
        });

        const hostname = conf.localhostOnly ? '127.0.0.1' : null;
        const server = http.createServer(app);

        server.listen(conf.port, hostname);

        server.on('error', (err) => {
            if (err.code === 'EADDRINUSE') {
                console.error(err);
                console.info("Error EADDRINUSE received, exiting process without restarting process...");
                process.exit(1)
            }
        });

        this.server = server;
        this.printerService = this._printerService;
    }
}