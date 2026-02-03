import Bonjour from 'bonjour-service';
import ipp from '@sealsystems/ipp';
import { EventEmitter } from 'events';
import crypto from 'crypto';

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
        
        if (this._enabled) {
            this._startDiscovery();
        }
    }

    _startDiscovery() {
        console.log('Starting printer discovery...');
        
        // Initialize Bonjour/mDNS service
        this._bonjour = new Bonjour.default();
        
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
        
        // Fetch printer capabilities
        this._fetchPrinterCapabilities(printerInfo).then(() => {
            this.emit('printer-added', printerInfo);
        }).catch(err => {
            console.error('Error fetching printer capabilities:', err);
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
                    "operation-attributes-tag": {
                        "requesting-user-name": "PairDrop",
                        "printer-uri": printerUri
                    }
                };

                ipp.request(printerUri, 'Get-Printer-Attributes', msg, (err, res) => {
                    if (err) {
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
                            printerState: attrs['printer-state']?.[0]?.value,
                            printerStateReasons: attrs['printer-state-reasons']?.[0]?.value
                        };

                        // Update printer status based on state
                        if (printer.capabilities.printerState === 3) {
                            printer.status = 'idle';
                        } else if (printer.capabilities.printerState === 4) {
                            printer.status = 'printing';
                        } else if (printer.capabilities.printerState === 5) {
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
                    // Printer not responding
                    if (printer.online) {
                        printer.online = false;
                        printer.status = 'offline';
                        this.emit('printer-updated', printer);
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

        return new Promise((resolve, reject) => {
            const msg = {
                "operation-attributes-tag": {
                    "requesting-user-name": options.userName || "PairDrop",
                    "job-name": fileName,
                    "document-format": options.mimeType || "application/pdf"
                },
                data: fileBuffer
            };

            // Add optional attributes
            if (options.copies) {
                msg["operation-attributes-tag"]["copies"] = options.copies;
            }

            if (options.sides) {
                msg["operation-attributes-tag"]["sides"] = options.sides;
            }

            if (options.colorMode) {
                msg["operation-attributes-tag"]["print-color-mode"] = options.colorMode;
            }

            ipp.request(printer.uri, 'Print-Job', msg, (err, res) => {
                if (err) {
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
        });
    }

    getPrinters() {
        return Array.from(this._printers.values()).filter(p => p.online);
    }

    getPrinter(printerId) {
        return this._printers.get(printerId);
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
