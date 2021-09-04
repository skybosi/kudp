/**
 * Tks https://github.com/husa/timer.js
 * 
 * Simple and lightweight library without any dependencies to create and manage, well, timers.
 */
(function (root, factory) {
    'use strict'
    if (typeof define === 'function' && define.amd) define([], factory)
    else if (typeof exports === 'object') module.exports = factory()
    else root.File = factory()
}(this, function () {
    'use strict'

    const Buffer = require('../lib/common/Buffer/Buffer.js')
    const FileSystemManager = wx.getFileSystemManager()

    const BUF_SIZ = 4194304 // 4 * 124 * 1024 kb
    var File = function (path, encoding) {
        if (!path || "" === path)
            throw new TypeError('The path argument must be of type string')
        this.buffer = Buffer.alloc(BUF_SIZ, 0)
        this.offset = 0;
        this.path = path;
        this.encoding = encoding || 'utf-8';
    }

    /**
     * @param {*} path  要写入的文件路径 (本地路径)
     * @param {*} data  要写入的文本或二进制数据
     * @param {*} encoding  指定写入文件的字符编码
     */
    function writeFile(ctx, buffer, data) {
        var bsize = buffer._woffset, dsize = data.length
        if (bsize + dsize < buffer.length) {
            buffer.writeBuffer(data);
        } else {
            ctx.flush(data);
        }
    }

    /**
     * @param {*} path  要读取的文件的路径 (本地路径)	
     * @param {*} encoding  指定读取文件的字符编码，如果不传 encoding，则以 ArrayBuffer 格式读取文件的二进制内容
     * @param {*} position  从文件指定位置开始读，如果不指定，则从文件头开始读。读取的范围应该是左闭右开区间 [position, position+length)。有效范围：[0, fileLength - 1]。单位：byte
     * @param {*} length  指定文件的长度，如果不指定，则读到文件末尾。有效范围：[1, fileLength]。单位：byte     
     */
    function readFile(path, encoding, position, length) {
        return FileSystemManager.readFileSync(
            wx.env.USER_DATA_PATH + '/' + path,
            encoding || 'utf-8',
            position,
            length,
        );
    }

    File.prototype.write = function write(data, encoding) {
        writeFile(this, this.buffer, data, encoding)
    }

    File.prototype.read = function read(offset, length, encoding) {
        return readFile(this.path, encoding, offset, length);
    }

    File.prototype.flush = function (data) {
        var that = this;
        var fun = (0 === that.offset)
            ? FileSystemManager.writeFile
            : FileSystemManager.appendFile
        fun({
            filePath: wx.env.USER_DATA_PATH + '/' + that.path,
            encoding: that.encoding || 'utf-8',
            data: that.buffer.buffer.slice(0, that.buffer._woffset),
            success: function (res) {
                console.log("writeFile", res, this)
                that.offset += that.buffer.length;
                that.buffer.flush();
                data && that.buffer.writeBuffer(data);
            },
            fail: function (e) {
                throw new TypeError(e.errMsg);
            }
        });
    }

    File.prototype.close = function close() {
        if (!this.buffer.empty()) {
            this.flush();
            this.offset = 0;
        }
    }

    return File
}))
