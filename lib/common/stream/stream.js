var _env = 'node'
let EventEmitter = require('./events');
let Buffer = require('./Buffer/Buffer')

let fs = null
try {
  fs = require('fs')
  _env == 'node'
} catch (error) {
  _env == 'wx'
  fs = wx.getFileSystemManager()
}

class ByteStream extends Buffer {
  constructor(string, encoding) {
    super(string, encoding)
  }
}

class Stream extends EventEmitter {
  constructor(path, options) {
    super();
    this.path = path; // 文件路径
    this.mode = options.mode || 0o666; // 文件模式
    this.start = options.start || 0; // 开始写入的位置
    this.autoClose = options.autoClose || true;
    this.fd = null; // 文件标识符，是number类型的
    this.pos = this.start; // 写入的时候也有位置关系
  }
  open() { // 异步地打开文件
    if (_env == 'wx') {
      let self = this
      fs.open({
        filePath: `${wx.env.USER_DATA_PATH}/` + self.path,
        flag: this.flags,
        success: (res) => {
          self.fd = res.fd; // 保存文件标识符
          self.emit('open'); // 发射'open'打开事件
        },
        fail: (err) => {
          self.emit('error', err); // 发射'error'错误事件
          if (self.autoClose) { // 如果autoClose为true，就要关闭文件
            self.destroy();
          }
          return;
        }
      })
    } else {
      fs.open(this.path, this.flags, this.mode, (err, fd) => {
        if (err) {
          this.emit('error', err); // 发射'error'错误事件
          if (this.autoClose) { // 如果autoClose为true，就要关闭文件
            this.destroy();
          }
          return;
        }
        this.fd = fd; // 保存文件标识符
        this.emit('open'); // 发射'open'打开事件
      })
    }
  }
  destroy() { // 关闭文件的操作
    if (_env == 'wx') {
      let self = this
      if (self.fd != null) {
        fs.close({
          fd: self.fd,
          success: () => {
            self.emit('close');
          },
          fail: err => {
            if (err) {
              self.emit('error', err);
              return;
            }
          }
        })
        return;
      }
    } else {
      if (this.fd != null) {
        fs.close(this.fd, (err) => {
          if (err) {
            this.emit('error', err);
            return;
          }
          this.emit('close'); // 发射'close'关闭文件事件
        })
        return;
      }
    }
    this.emit('close');
  }
}

class ReadStream extends Stream {
  constructor(path, options = {}) {
    super(path, options);
    this.flags = options.flags || 'r';
    this.encoding = options.encoding || null;
    this.highWaterMark = options.highWaterMark || 64 * 1024;
    this.flowing = null; // 记录当前是否是流动模式
    this.buffer = Buffer.alloc(this.highWaterMark); // 构建读取后存放内容的buffer
    this.open();
    this.on('newListener', (type) => { // 绑定 'newListener'事件，监听是否绑定了 'data'事件
      if (type === 'data') {
        this.flowing = true;
        this.read(); // 开始读文件
      }
    })
  }
  read() { // 读取文件
    if (this.finished) { // 读完之后就不再读了
      return;
    }
    // open打开文件是异步的，当我们读取的时候可能文件还没有打开
    if (this.fd == null) {
      this.once('open', () => this.read());
      return;
    }
    // length代表每次读取的字节数 如果this.end = 4;说明要读取5个字节，this.highWaterMark= 3；说明每次读取3个，第一次读完后this.pos = 3;此时还需要在读取2个字节就够了
    let length = this.end ? Math.min(this.highWaterMark, this.end - this.pos + 1) : this.highWaterMark;
    //参数： 文件标识符， 数据将被写入到的buffer，buffer中开始写入的位置， 要读取的字节数， 从文件中开始读取的位置
    if (_env == 'wx') {
      let self = this
      fs.read({
        fd: this.fd,
        arrayBuffer: this.buffer.buffer,
        offset: 0,
        length: length,
        position: this.pos,
        success: (res) => {
          // console.log(res)
          let bytesRead = res.bytesRead
          if (bytesRead > 0) { // 读到的字节数 
            self.pos += bytesRead;
            // let res = self.buffer.slice(0, bytesRead); // 真实读取到的bytesRead可能不能填满this.buffer，需要截取,保留有用的
            let res = self.encoding ? self.buffer.slice(0, bytesRead).toString(self.encoding) : self.buffer.slice(0, bytesRead);
            self.emit('data', res);
            if (self.flowing) { // 如果是流动模式，就继续调用read方法读取
              self.read();
            }
          } else {
            self.finished = true; // 读完的标识
            self.emit('end');
            self.destroy();
          }
        },
        fail: err => {
          self.emit('error', err);
          self.destroy();
          return;
        }
      })
    } else {
      fs.read(this.fd, this.buffer, 0, length, this.pos, (err, bytesRead) => {
        if (err) {
          this.emit('error', err);
          this.destroy();
          return;
        }
        if (bytesRead > 0) { // 读到的字节数 
          this.pos += bytesRead;
          let res = this.buffer.slice(0, bytesRead); // 真实读取到的bytesRead可能不能填满this.buffer，需要截取,保留有用的
          res = this.encoding ? res.toString(this.encoding) : res;
          this.emit('data', res);
          if (this.flowing) { // 如果是流动模式，就继续调用read方法读取
            this.read();
          }
        } else {
          this.finished = true; // 读完的标识
          this.emit('end');
          this.destroy();
        }
      })
    }
  }
  pause() { // 暂停监听 'data' 事件
    this.flowing = false;
  }
  resume() { // 开始监听 'data' 事件
    this.flowing = true;
    this.read();
  }
  pipe(dest) {
    this.on('data', (data) => {
      let flag = dest.write(data);
      if (!flag) {
        this.pause(); // 不能继续读取了，等写入完成后再继续读取
      }
    });
    dest.on('drain', () => {
      this.resume();
    })
  }
}

class WriteStream extends Stream {
  constructor(path, options = {}) {
    super(path, options);
    this.flags = options.flags || 'w'; // 文件写入的方式
    this.encoding = options.encoding || 'utf8';
    this.highWaterMark = options.highWaterMark || 64 * 1024; // 设置的
    this.needDrain = false; // 是否需要触发drain事件
    this.writing = false; // 是否正在写入，判断是否是第一次写入
    this.buffer = []; // 用数组模拟一个缓存 第二次之后的写入就放到缓存中（源码中用的是链表）
    this.len = 0;// 维护一个变量，计算当前缓存的长度
    this.open();
  }
  // chunk：写入的内容；encoding：编码格式；callback：写入完成后的回调
  write(chunk, encoding = this.encoding, callback) { // 写入的时候调用的方法
    // 为了统一，如果传递的是字符串也要转成buffer
    chunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
    this.len += chunk.length; // 维护缓存的长度
    let ret = this.highWaterMark > this.len;
    if (!ret) {
      this.needDrain = true; // 表示需要触发drain事件
    }
    // if (this.writing) { // true表示正在写入,应该放在缓存中
    //   this.buffer.push({ chunk, encoding, callback });
    // } else { // 第一次写入
    //   this.writing = true;
    //   this._write(chunk, encoding, () => this.clearBuffer()); // 实现一个写入的方法
    // }
    this._write(chunk, encoding, () => this.clearBuffer()); // 实现一个写入的方法

    return ret; // write的返回值必须是true/false
  }
  _write(chunk, encoding, callback) { // 因为write方法是同步调用的，此时fd可能还没有获取到
    if (this.fd == null) { // 判断如果文件还没有打开
      return this.once('open', () => this._write(chunk, encoding, callback));
    }
    // 参数：fd 文件描述符； chunk是数据； 0：写入的buffer开始的位置； chunk.length写入的字节数； this.pos文件开始写入数据的位置的偏移量
    if (_env == 'wx') {
      let self = this
      // 写入文件
      fs.write({
        fd: self.fd, data: chunk.buffer, offset: 0, length: chunk.length, position: self.pos,
        success: (res) => {
          // console.log(res.bytesWritten)
          let bytesWritten = res.bytesWritten || chunk.length
          this.pos += bytesWritten;
          this.len -= bytesWritten; // 每次写入后，内存中的也要相应的减少
          callback();
        },
        fail: err => {
          console.log(err)
        }
      })
    } else {
      fs.write(this.fd, chunk, 0, chunk.length, this.pos, (err, bytesWritten) => {
        if (err) {
          if (this.autoClose) {
            this.destroy();
            this.emit('error', err);
          }
        }
        this.pos += bytesWritten;
        this.len -= bytesWritten; // 每次写入后，内存中的也要相应的减少
        callback && callback();
      })
    }
  }
  clearBuffer() { // 清除缓存中的
    let buf = this.buffer.shift();
    if (buf) {
      this._write(buf.chunk, buf.encoding, () => this.clearBuffer());
    } else {
      if (this.needDrain) { // 如果需要触发drain
        this.writing = false;
        this.needDrain = false;// 触发一次drain 再置回false 方便下次继续判断
        this.emit('drain');
      }
    }
  }
}

module.exports = {
  ByteStream: ByteStream,
  ReadStream: ReadStream,
  WriteStream: WriteStream,
}