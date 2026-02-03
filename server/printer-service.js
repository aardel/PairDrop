import Bonjour from 'bonjour-service';
import ipp from '@sealsystems/ipp';
import { EventEmitter } from 'events';
import crypto from 'crypto';
import https from 'https';
import { exec } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { PWGRasterEncoder } from './pwg-raster.js';

// IPP Printer State Constants
const PRINTER_STATE_IDLE = 3;
const PRINTER_STATE_PRINTING = 4;
const PRINTER_STATE_STOPPED = 5;

/**
 * PrinterService - Discovers network printers and manages print jobs
 * Emits events: 'printer-added', 'printer-removed', 'printer-updated'
 */
export default class PrinterService extends EventEmitter {
    constructor(conf) {
        super();
        this._conf = conf;
        this._printers = new Map(); // printerId -> printer info
        this._bonjour = null;
        this._browser = null;
        this._refreshInterval = null;
        this._enabled = process.env.PRINTER_DISCOVERY === "true";
        this._httpsAgent = new https.Agent({ rejectUnauthorized: false });
        this._cupsPrinters = new Map(); // Maps mDNS printer names to CUPS queue names
        this._cupsPrinterQueues = []; // List of available CUPS queues

        if (this._enabled) {
            this._startDiscovery();
        } else {
            console.log('Printer discovery disabled. Set PRINTER_DISCOVERY=true to enable.');
        }
    }

    _startDiscovery() {
        console.log('Starting printer discovery...');
        if (process.platform === 'darwin') {
            console.log('  (macOS: run with "npm start" on the host, not in Docker. If no printers appear, allow Node in System Settings > Network > Firewall, and ensure printer is on the same Wi‑Fi/LAN.)');
        }
        
        // Detect CUPS printers for mapping
        this._detectCUPSPrinters();

        // Initialize Bonjour/mDNS service (support both ESM default and CJS .default)
        const BonjourClass = typeof Bonjour?.default === 'function' ? Bonjour.default : Bonjour;
        this._bonjour = new BonjourClass();

        // Browse for IPP and IPP-SSL printers on the network
        this._browser = this._bonjour.find({ type: 'ipp' }, (service) => {
            this._onPrinterDiscovered(service);
        });

        // Also browse for IPPS (IPP over SSL)
        this._bonjour.find({ type: 'ipps' }, (service) => {
            this._onPrinterDiscovered(service);
        });

        // Periodically check printer status
        this._refreshInterval = setInterval(() => {
            this._refreshPrinterStatus();
        }, 30000); // Check every 30 seconds
    }

    _onPrinterDiscovered(service) {
        if (!service || !service.name) return;

        const printerId = this._generatePrinterId(service);

        // Check if printer already exists
        if (this._printers.has(printerId)) {
            const existingPrinter = this._printers.get(printerId);
            existingPrinter.lastSeen = Date.now();
            if (!existingPrinter.online) {
                existingPrinter.online = true;
                existingPrinter.status = 'idle';
                this.emit('printer-updated', existingPrinter);
            }
            return;
        }

        const printerInfo = {
            id: printerId,
            name: service.name,
            host: service.host || service.addresses?.[0],
            port: service.port || 631,
            type: service.type,
            txt: service.txt || {},
            status: 'idle',
            online: true,
            capabilities: {},
            lastSeen: Date.now()
        };

        // Get printer URI
        printerInfo.uri = this._buildPrinterUri(printerInfo);

        this._printers.set(printerId, printerInfo);

        console.log('Printer discovered:', printerInfo.name, printerInfo.uri);
        
        // Try to map to CUPS queue
        const cupsQueue = this._mapPrinterToCUPS(printerInfo);
        if (cupsQueue) {
            this._cupsPrinters.set(printerId, cupsQueue);
            console.log('  Mapped to CUPS queue:', cupsQueue);
        }

        // Fetch printer capabilities
        this._fetchPrinterCapabilities(printerInfo).then(() => {
            this.emit('printer-added', printerInfo);
        }).catch(err => {
            if (err.message !== 'Data required') console.error('Error fetching printer capabilities:', err);
            this.emit('printer-added', printerInfo);
        });
    }

    _generatePrinterId(service) {
        const data = `${service.name}-${service.host || service.addresses?.[0]}-${service.port || 631}`;
        return crypto.createHash('md5').update(data).digest('hex').substring(0, 12);
    }

    _buildPrinterUri(printer) {
        const protocol = printer.type === 'ipps' ? 'ipps' : 'ipp';
        const host = printer.host;
        const port = printer.port;

        // Try to get the resource path from TXT record
        const rp = printer.txt?.rp || 'ipp/print';

        return `${protocol}://${host}:${port}/${rp}`;
    }

    async _fetchPrinterCapabilities(printer) {
        return new Promise((resolve, reject) => {
            try {
                const printerUri = printer.uri;

                const msg = {
                    operation: 'Get-Printer-Attributes',
                    'operation-attributes-tag': {
                        'attributes-charset': 'utf-8',
                        'attributes-natural-language': 'en',
                        'printer-uri': printerUri,
                        'requested-attributes': [
                            'printer-state',
                            'printer-state-reasons',
                            'document-format-supported',
                            'color-supported',
                            'sides-supported',
                            'media-supported'
                        ]
                    }
                };

                const serialized = ipp.serialize(msg);
                const urlObj = new URL(printerUri);
                const opts = {
                    protocol: urlObj.protocol,
                    hostname: urlObj.hostname,
                    port: urlObj.port || (urlObj.protocol === 'ipps:' ? 631 : 631),
                    path: urlObj.pathname
                };
                if (printerUri.startsWith('ipps://')) {
                    opts.agent = this._httpsAgent;
                }

                ipp.request(opts, serialized, (err, res) => {
                    if (err) {
                        if (err.message === 'Data required') {
                            // Some printers (e.g. EPSON L3250) return a response the library can't parse; treat as OK
                            resolve();
                            return;
                        }
                        console.error('Error getting printer attributes:', err);
                        reject(err);
                        return;
                    }

                    try {
                        const attrs = res['printer-attributes-tag'] || {};

                        printer.capabilities = {
                            colorSupported: attrs['color-supported']?.[0]?.value ?? false,
                            sidesSupported: attrs['sides-supported']?.[0]?.value ?? ['one-sided'],
                            mediaSupported: attrs['media-supported']?.[0]?.value ?? ['na_letter_8.5x11in'],
                            documentFormatSupported: attrs['document-format-supported'] || ['application/octet-stream'],
                            printerState: attrs['printer-state']?.[0]?.value,
                            printerStateReasons: attrs['printer-state-reasons']?.[0]?.value
                        };

                        // Update printer status based on state
                        if (printer.capabilities.printerState === PRINTER_STATE_IDLE) {
                            printer.status = 'idle';
                        } else if (printer.capabilities.printerState === PRINTER_STATE_PRINTING) {
                            printer.status = 'printing';
                        } else if (printer.capabilities.printerState === PRINTER_STATE_STOPPED) {
                            printer.status = 'stopped';
                        }

                        resolve();
                    } catch (parseErr) {
                        console.error('Error parsing printer attributes:', parseErr);
                        reject(parseErr);
                    }
                });
            } catch (err) {
                console.error('Error in _fetchPrinterCapabilities:', err);
                reject(err);
            }
        });
    }

    async _refreshPrinterStatus() {
        const now = Date.now();
        const timeout = 60000; // 60 seconds

        for (const [printerId, printer] of this._printers.entries()) {
            // Check if printer is still responding
            if (now - printer.lastSeen > timeout) {
                // Mark as offline
                if (printer.online) {
                    printer.online = false;
                    printer.status = 'offline';
                    this.emit('printer-updated', printer);
                }
            } else {
                // Try to fetch status
                try {
                    await this._fetchPrinterCapabilities(printer);
                    printer.lastSeen = now;
                    printer.online = true;
                    this.emit('printer-updated', printer);
                } catch (err) {
                    // If "Data required", treat as online (EPSON quirk)
                    if (err.message === 'Data required') {
                        printer.lastSeen = now;
                        printer.online = true;
                        this.emit('printer-updated', printer);
                    } else {
                        // Don't mark offline immediately on IPP errors;
                        // mDNS presence is sufficient. Only timeout marks offline.
                        if (err.message !== 'Data required') {
                            console.warn(`Printer ${printer.name} IPP check failed (keeping online via mDNS):`, err.message);
                        }
                    }
                }
            }
        }
    }

    async submitPrintJob(printerId, fileBuffer, fileName, options = {}) {
        const printer = this._printers.get(printerId);

        if (!printer) {
            throw new Error('Printer not found');
        }

        if (!printer.online) {
            throw new Error('Printer is offline');
        }

        // Determine best printing method based on platform and file type
        const mimeType = (options.mimeType || '').toLowerCase();
        const isImage = mimeType.startsWith('image/');
        
        // Use CUPS on macOS/Linux when available (handles all formats)
        if (process.platform === 'darwin' || process.platform === 'linux') {
            return this._submitPrintJobViaCUPS(printer, fileBuffer, fileName, options);
        }
        
        // For images on other platforms, convert to PWG Raster
        if (isImage && mimeType !== 'image/pwg-raster') {
            return this._submitPrintJobAsPWGRaster(printer, fileBuffer, fileName, options);
        }

        // For PDF or other formats, try direct IPP
        return this._submitPrintJobViaIPP(printer, fileBuffer, fileName, options);
    }

    async _submitPrintJobViaIPP(printer, fileBuffer, fileName, options = {}) {
        return new Promise((resolve, reject) => {
            const mimeType = (options.mimeType || 'application/pdf').toLowerCase();
            const msg = {
                operation: 'Print-Job',
                'operation-attributes-tag': {
                    'attributes-charset': 'utf-8',
                    'attributes-natural-language': 'en',
                    'printer-uri': printer.uri.replace(/^ipp:/, 'ipps:'), // Use IPPS if available
                    'requesting-user-name': options.userName || 'PairDrop',
                    'job-name': fileName,
                    'document-format': mimeType
                },
                data: Buffer.isBuffer(fileBuffer) ? fileBuffer : Buffer.from(fileBuffer)
            };

            if (options.copies) {
                msg['operation-attributes-tag'].copies = options.copies;
            }
            if (options.sides) {
                msg['operation-attributes-tag'].sides = options.sides;
            }
            if (options.colorMode) {
                msg['operation-attributes-tag']['print-color-mode'] = options.colorMode;
            }

            let serialized;
            try {
                serialized = ipp.serialize(msg);
            } catch (serErr) {
                reject(serErr);
                return;
            }

            const doRequest = (uri, isRetry) => {
                const urlObj = new URL(uri);
                const opts = {
                    protocol: urlObj.protocol,
                    hostname: urlObj.hostname,
                    port: urlObj.port || 631,
                    path: urlObj.pathname
                };
                if (uri.startsWith('ipps://')) {
                    opts.agent = this._httpsAgent;
                }
                
                ipp.request(opts, serialized, (err, res) => {
                    if (err) {
                        if (err.message === 'Data required') {
                            console.log('Print job sent to', printer.name, '(printer response not parsed)');
                            resolve({
                                jobId: null,
                                jobState: 'unknown',
                                printerId: printer.id,
                                printerName: printer.name
                            });
                            return;
                        }
                        // Some printers return 426 but the job was already sent; treat as success
                        if (err.message && (err.message.includes('426') || (isRetry && err.code === 'EPIPE'))) {
                            console.log('Print job sent to', printer.name, '(printer returned 426 or connection error after 426)');
                            resolve({
                                jobId: null,
                                jobState: 'unknown',
                                printerId: printer.id,
                                printerName: printer.name
                            });
                            return;
                        }
                        console.error('Error submitting print job:', err);
                        reject(err);
                        return;
                    }

                    try {
                        const jobAttrs = res['job-attributes-tag'] || {};
                        const jobId = jobAttrs['job-id']?.[0]?.value;
                        const jobState = jobAttrs['job-state']?.[0]?.value;

                        resolve({
                            jobId,
                            jobState,
                            printerId: printer.id,
                            printerName: printer.name
                        });
                    } catch (parseErr) {
                        console.error('Error parsing print job response:', parseErr);
                        reject(parseErr);
                    }
                });
            };

            doRequest(printer.uri, false);
        });
    }

    getPrinters() {
        return Array.from(this._printers.values());
    }

    getOnlinePrinters() {
        return Array.from(this._printers.values()).filter(p => p.online);
    }

    getPrinter(printerId) {
        return this._printers.get(printerId);
    }

    async _submitPrintJobAsPWGRaster(printer, fileBuffer, fileName, options = {}) {
        console.log('Converting image to PWG Raster for', printer.name);
        
        try {
            const pwgBuffer = await PWGRasterEncoder.encode(fileBuffer, options);
            console.log('PWG Raster conversion complete, size:', pwgBuffer.length, 'bytes');
            
            // Submit as PWG Raster
            return this._submitPrintJobViaIPP(printer, pwgBuffer, fileName, {
                ...options,
                mimeType: 'image/pwg-raster'
            });
        } catch (err) {
            console.error('PWG Raster conversion failed:', err);
            throw new Error(`Cannot convert image to printer format: ${err.message}`);
        }
    }

    _detectCUPSPrinters() {
        if (process.platform !== 'darwin' && process.platform !== 'linux') return;
        
        exec('lpstat -a 2>/dev/null', (error, stdout) => {
            if (error) return;
            
            // Parse output like "EPSON_L3250_Series_2 accepting requests since..."
            const lines = stdout.split('\n');
            const cupsQueues = [];
            lines.forEach(line => {
                const match = line.match(/^([^\s]+)\s+accepting/);
                if (match) {
                    const cupsName = match[1];
                    cupsQueues.push(cupsName);
                    console.log('  Found CUPS printer:', cupsName);
                }
            });
            
            // Try to match CUPS queues to discovered printers later
            this._cupsPrinterQueues = cupsQueues;
        });
    }
    
    _mapPrinterToCUPS(printer) {
        if (!this._cupsPrinterQueues) return null;
        
        // Try exact match first
        const exactMatch = this._cupsPrinterQueues.find(q => 
            q.toLowerCase() === printer.name.toLowerCase()
        );
        if (exactMatch) return exactMatch;
        
        // Try fuzzy match (remove spaces/special chars)
        const normalizedName = printer.name.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
        const fuzzyMatch = this._cupsPrinterQueues.find(q => 
            q.replace(/[^a-zA-Z0-9]/g, '').toLowerCase() === normalizedName
        );
        if (fuzzyMatch) return fuzzyMatch;
        
        // Try partial match
        const partialMatch = this._cupsPrinterQueues.find(q => 
            q.toLowerCase().includes(printer.name.toLowerCase()) ||
            printer.name.toLowerCase().includes(q.toLowerCase())
        );
        if (partialMatch) return partialMatch;
        
        return null;
    }

    async _submitPrintJobViaCUPS(printer, fileBuffer, fileName, options = {}) {
        return new Promise((resolve, reject) => {
            // Try to find CUPS queue name for this printer
            let cupsName = this._mapPrinterToCUPS(printer);
            if (!cupsName) {
                // Fallback: sanitize printer name to match likely CUPS queue name
                cupsName = printer.name.replace(/[^a-zA-Z0-9_-]/g, '_');
                console.log('No CUPS queue match found, using sanitized name:', cupsName);
            } else {
                console.log('Matched to CUPS queue:', cupsName);
            }
            
            // Write to temp file
            const tempFile = path.join(os.tmpdir(), `pairdrop-${Date.now()}-${fileName}`);
            fs.writeFileSync(tempFile, fileBuffer);
            
            const copies = options.copies || 1;
            const cmd = `lp -d "${cupsName}" -n ${copies} "${tempFile}"`;
            
            console.log('Submitting via CUPS to queue:', cupsName);
            
            exec(cmd, {timeout: 30000}, (error, stdout, stderr) => {
                // Clean up temp file
                try {
                    fs.unlinkSync(tempFile);
                } catch (_) {}
                
                if (error) {
                    console.error('CUPS print error:', error.message);
                    console.error('stderr:', stderr);
                    reject(new Error(`CUPS error: ${stderr || error.message}`));
                    return;
                }
                
                console.log('CUPS print successful:', stdout.trim());
                
                // Parse job ID from stdout like "request id is EPSON_L3250_Series_2-27 (1 file(s))"
                const match = stdout.match(/request id is ([^ ]+)/);
                const jobId = match ? match[1] : null;
                
                resolve({
                    jobId,
                    jobState: 'processing',
                    printerId: printer.id,
                    printerName: printer.name
                });
            });
        });
    }

    isEnabled() {
        return this._enabled;
    }

    destroy() {
        if (this._refreshInterval) {
            clearInterval(this._refreshInterval);
        }

        if (this._browser) {
            this._browser.stop();
        }

        if (this._bonjour) {
            this._bonjour.destroy();
        }
    }
}
