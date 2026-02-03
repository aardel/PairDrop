/**
 * PWG Raster encoder for IPP printing
 * Converts images to PWG Raster format (RFC 6750) that most network printers support
 */

export class PWGRasterEncoder {
    /**
     * Convert an image buffer to PWG Raster format
     * @param {Buffer} imageBuffer - Input image (JPEG, PNG, etc.)
     * @param {Object} options - Conversion options
     * @returns {Promise<Buffer>} PWG Raster formatted buffer
     */
    static async encode(imageBuffer, options = {}) {
        const sharp = (await import('sharp')).default;
        
        // Get image metadata
        const image = sharp(imageBuffer);
        const metadata = await image.metadata();
        
        // Convert to raw RGB
        const { data, info } = await image
            .removeAlpha()
            .raw()
            .toBuffer({ resolveWithObject: true });
        
        const width = info.width;
        const height = info.height;
        const channels = info.channels; // Should be 3 for RGB
        
        // Build PWG Raster file
        const header = this._buildPWGHeader(width, height, options);
        const pageData = this._buildPageData(data, width, height, channels);
        
        return Buffer.concat([header, pageData]);
    }
    
    static _buildPWGHeader(width, height, options = {}) {
        const buffer = Buffer.alloc(1796);
        let offset = 0;
        
        // PWG Raster synchronization word
        buffer.write('RaS2', offset, 'ascii');
        offset += 4;
        
        // Page header (1792 bytes total from start)
        // MediaColor (64 bytes)
        buffer.fill(0, offset, offset + 64);
        offset += 64;
        
        // MediaType (64 bytes)
        buffer.fill(0, offset, offset + 64);
        offset += 64;
        
        // PrintContentOptimize (64 bytes)
        buffer.fill(0, offset, offset + 64);
        offset += 64;
        
        // Reserved bytes and other fields (skipping details, setting key fields)
        buffer.fill(0, offset, offset + 12);
        offset += 12;
        
        // CutMedia (4 bytes)
        buffer.writeUInt32BE(0, offset); offset += 4;
        
        // Duplex (4 bytes) - 0 = none
        buffer.writeUInt32BE(0, offset); offset += 4;
        
        // HWResolution (8 bytes) - 300 DPI
        buffer.writeUInt32BE(300, offset); offset += 4;
        buffer.writeUInt32BE(300, offset); offset += 4;
        
        // Reserved
        buffer.fill(0, offset, offset + 16);
        offset += 16;
        
        // InsertSheet (4 bytes)
        buffer.writeUInt32BE(0, offset); offset += 4;
        
        // Jog (4 bytes)
        buffer.writeUInt32BE(0, offset); offset += 4;
        
        // LeadingEdge (4 bytes)
        buffer.writeUInt32BE(0, offset); offset += 4;
        
        // Reserved
        buffer.fill(0, offset, offset + 12);
        offset += 12;
        
        // MediaPosition (4 bytes)
        buffer.writeUInt32BE(0, offset); offset += 4;
        
        // MediaWeight (4 bytes)
        buffer.writeUInt32BE(0, offset); offset += 4;
        
        // Reserved
        buffer.fill(0, offset, offset + 8);
        offset += 8;
        
        // NumCopies (4 bytes)
        buffer.writeUInt32BE(options.copies || 1, offset); offset += 4;
        
        // Orientation (4 bytes)
        buffer.writeUInt32BE(0, offset); offset += 4;
        
        // Reserved
        buffer.fill(0, offset, offset + 4);
        offset += 4;
        
        // PageSize (8 bytes) - width and height in points (1/72 inch)
        const pageWidthPoints = Math.round(width * 72 / 300);
        const pageHeightPoints = Math.round(height * 72 / 300);
        buffer.writeUInt32BE(pageWidthPoints, offset); offset += 4;
        buffer.writeUInt32BE(pageHeightPoints, offset); offset += 4;
        
        // Reserved
        buffer.fill(0, offset, offset + 16);
        offset += 16;
        
        // Tumble (4 bytes)
        buffer.writeUInt32BE(0, offset); offset += 4;
        
        // Width (4 bytes) - in pixels
        buffer.writeUInt32BE(width, offset); offset += 4;
        
        // Height (4 bytes) - in pixels  
        buffer.writeUInt32BE(height, offset); offset += 4;
        
        // Reserved
        buffer.fill(0, offset, offset + 4);
        offset += 4;
        
        // BitsPerColor (4 bytes) - 8 for RGB
        buffer.writeUInt32BE(8, offset); offset += 4;
        
        // BitsPerPixel (4 bytes) - 24 for RGB
        buffer.writeUInt32BE(24, offset); offset += 4;
        
        // BytesPerLine (4 bytes)
        buffer.writeUInt32BE(width * 3, offset); offset += 4;
        
        // ColorOrder (4 bytes) - 0 = chunky (RGB RGB RGB...)
        buffer.writeUInt32BE(0, offset); offset += 4;
        
        // ColorSpace (4 bytes) - 19 = sRGB
        buffer.writeUInt32BE(19, offset); offset += 4;
        
        // Reserved
        buffer.fill(0, offset, offset + 16);
        offset += 16;
        
        // NumColors (4 bytes) - 3 for RGB
        buffer.writeUInt32BE(3, offset); offset += 4;
        
        // Reserved
        buffer.fill(0, offset, offset + 28);
        offset += 28;
        
        // TotalPageCount (4 bytes)
        buffer.writeUInt32BE(1, offset); offset += 4;
        
        // CrossFeedTransform (4 bytes)
        buffer.writeUInt32BE(1, offset); offset += 4;
        
        // FeedTransform (4 bytes)
        buffer.writeUInt32BE(1, offset); offset += 4;
        
        // ImageBoxLeft, ImageBoxTop, ImageBoxRight, ImageBoxBottom (16 bytes)
        buffer.writeUInt32BE(0, offset); offset += 4;
        buffer.writeUInt32BE(0, offset); offset += 4;
        buffer.writeUInt32BE(width, offset); offset += 4;
        buffer.writeUInt32BE(height, offset); offset += 4;
        
        // AlternatePrimary, PrintQuality (8 bytes)
        buffer.fill(0, offset, offset + 8);
        offset += 8;
        
        // Reserved to fill rest of 1792-byte header (after initial 4-byte sync word)
        buffer.fill(0, offset, 1796);
        
        return buffer;
    }
    
    static _buildPageData(rgbData, width, height, channels) {
        // PWG Raster page data is uncompressed RGB scanlines
        // Each line starts with a repeat count (1 for uncompressed)
        
        const bytesPerLine = width * 3;
        const lines = [];
        
        for (let y = 0; y < height; y++) {
            const lineHeader = Buffer.alloc(1);
            lineHeader.writeUInt8(1, 0); // Repeat count = 1 (no compression)
            
            const lineData = Buffer.alloc(bytesPerLine);
            const srcOffset = y * width * channels;
            
            for (let x = 0; x < width; x++) {
                const pixelSrcOffset = srcOffset + (x * channels);
                const pixelDstOffset = x * 3;
                
                lineData[pixelDstOffset] = rgbData[pixelSrcOffset];     // R
                lineData[pixelDstOffset + 1] = rgbData[pixelSrcOffset + 1]; // G
                lineData[pixelDstOffset + 2] = rgbData[pixelSrcOffset + 2]; // B
            }
            
            lines.push(Buffer.concat([lineHeader, lineData]));
        }
        
        return Buffer.concat(lines);
    }
}
