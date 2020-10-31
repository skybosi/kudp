(function (root, factory) {
  'use strict'
  if (typeof define === 'function' && define.amd) define([], factory)
  else if (typeof exports === 'object') module.exports = factory()
  else root.Messge = factory()
}(this, function () {

  //arrays成员类型可以是 ArrayBuffer 或 TypeArray
  function mergeArrayBuffer(...arrays) {
    let totalLen = 0
    for (let i = 0, len = arrays.length; i < len; i++) {
      arrays[i] = new Uint8Array(arrays[i]) //全部转成Uint8Array
      totalLen += arrays[i].length
    }
    let res = new Uint8Array(totalLen)
    let offset = 0
    for (let arr of arrays) {
      res.set(arr, offset)
      offset += arr.length
    }
    return res.buffer
  }

  /**
   * Number to ArrayBuffer
   * @param {Number} num 
   * @param {Number} size : 1 2 4 byte
   * @param {Boolean} flag 
   */
  const number2IntArray = (buffer, num, size, offset, flag) => {
    size = size ? size : 1
    offset = offset || 0
    buffer = buffer || new ArrayBuffer(size);
    let dv = new DataView(buffer);
    switch (size) {
      case 1:
        (flag == true) ? dv.setInt8(offset, num) : dv.setUint8(offset, num);
        break;
      case 2:
        (flag == true) ? dv.setInt16(offset, num) : dv.setUint16(offset, num);
        break;
      case 4:
        (flag == true) ? dv.setInt32(offset, num) : dv.setUint32(offset, num);
        break;
      default:
        (flag == true) ? dv.setInt8(offset, num) : dv.setUint8(offset, num);
        break
    }
    return buffer
  }

  /**
   * ArrayBuffer to Number
   * @param {ArrayBuffer} arr 
   * @param {Number} size : 1 2 4 byte
   * @param {Boolean} flag 
   */
  const intArray2Number = (buffer, size, flag) => {
    let num = 0
    size = size ? size : 1
    let dv = new DataView(buffer);
    switch (size) {
      case 1:
        num = (flag == true) ? dv.getInt8() : dv.getUint8();
        break;
      case 2:
        num = (flag == true) ? dv.getInt16() : dv.getUint16();
        break;
      case 4:
        num = (flag == true) ? dv.getInt32() : dv.getUint32();
        break;
      default:
        num = (flag == true) ? dv.getInt8() : dv.getUint8();
        break
    }
    return num
  }

  /**
   * ArrayBuffer转为字符串，参数为ArrayBuffer对象
   * @param {ArrayBuffer} buf 
   */
  const ab2str = (buf) => {
    let encodedString = buf && (buf.byteLength > 0) ? String.fromCharCode.apply(null, new Uint16Array(buf)) : '';
    return encodedString
  }

  /**
   * 字符串转为ArrayBuffer对象，参数为字符串
   * @param {String} str 
   */
  const str2ab = (str) => {
    let strLen = str.length
    if (strLen == 0) {
      return new ArrayBuffer(0)
    }
    let buf = new ArrayBuffer(strLen * 2); // 每个字符占用2个字节
    let bufView = new Uint16Array(buf);
    for (let i = 0; i < strLen; i++) {
      bufView[i] = str.charCodeAt(i);
    }
    return buf;
  }

  const Uint8ArrayToString = (u8) => {
    var str = "";
    for (var i = 0; i < u8.length; i++) {
      str += String.fromCharCode(u8[i]);
    }
    return str
  }

  const stringToUint8Array = (str) => {
    var arr = [];
    for (var i = 0, j = str.length; i < j; ++i) {
      arr.push(str.charCodeAt(i));
    }
    return new Uint8Array(arr);
  }

  class Messge {
    constructor(buffer) {
      if (!buffer) {
        this.buffer = new ArrayBuffer(0);
      } else {
        this.buffer = buffer;
      }
      this.offset = 0;
    }

    setNumber(num, size, offset, flag) {
      size = size ? size : 1
      this.buffer = number2IntArray(this.buffer, num, size, offset, flag);
    }
    /**
     * 将数字写入buffer
     * @param {Number} num 
     * @param {Number} size 1 2 4, byte
     * @param {Boolean} flag 
     */
    writeNumber(num, size, flag) {
      size = size ? size : 1;
      let arr = number2IntArray(null, num, size, 0, flag);
      this.buffer = this.buffer ? mergeArrayBuffer(this.buffer, arr) : arr;
      return true
    }

    /**
     * 将字符串写入buffer
     * @param {String} str
     */
    writeString(str) {
      if (typeof str === 'object') {
        return this.writeObject(str)
      }
      if (!str) {
        return false;
      }
      return this.writeBuffer(str2ab(str));
    }

    /**
     * 将字符串写入buffer
     * @param {String} str
     */
    writeBuffer(buf) {
      this.buffer = this.buffer ? mergeArrayBuffer(this.buffer, buf) : buf;
      return true
    }

    /**
     * 将字符串写入buffer
     * @param {String} str 
     */
    writeObject(obj) {
      try {
        let str = JSON.stringify(obj)
        if (str && 0 != str.length) {
          let arr = str2ab(str);
          this.buffer = this.buffer ? mergeArrayBuffer(this.buffer, arr) : arr;
        }
      } catch (e) {
        console.error(e)
        return false
      }
      return true
    }

    /**
     * 从Message的ArrayBuffer中读取数字
     * @param {Number} offset 1 2 4, byte
     * @param {Boolean} flag 
     */
    readNumber(size, flag) {
      size = size ? size : 1;
      let arr = this.buffer.slice(this.offset, this.offset + size);
      this.offset += size;
      return intArray2Number(arr, size, flag);
    }

    /**
     * 从Message的ArrayBuffer中读取字符串
     * @param {*} offset 
     */
    readString(offset) {
      let arr = null;
      if (!offset) {
        arr = this.buffer.slice(this.offset);
        this.offset = this.buffer.bytelength;
      } else {
        arr = this.buffer.slice(this.offset, offset);
        this.offset += offset;
      }
      let ostr = ab2str(arr);
      try {
        return JSON.parse(ostr)
      } catch (e) {
        return ostr
      }
    }
    /**
     * 从Message的ArrayBuffer中读取可能的json string，转Object
     * @param {*} offset
     */
    readObject(offset) {
      let ostr = this.readString(offset)
      try {
        return JSON.parse(ostr)
      } catch (e) {
        return {}
      }
    }
    /**
     * 从Message的ArrayBuffer中读取ArrayBuffer
     * @param {*} offset
     */
    readBuffer(offset) {
      let arr = null;
      if (!offset) {
        arr = this.buffer.slice(this.offset);
        this.offset = this.buffer.bytelength;
      } else {
        arr = this.buffer.slice(this.offset, offset);
        this.offset += offset;
      }
      return arr;
    }
    // 转换为Bytes
    toBytes() {
      return Messge.Bytes(this.buffer);
    }
    // 拼接两个Uint8Array
    static concatBuffers(arr) {
      if (!Array.isArray(arr)) {
        arr = Array.prototype.slice.call(arguments, 0);
      }
      var len = 0, i = 0;
      for (i = 0; i < arr.length; ++i) {
        len += arr[i].byteLength;
      }

      var u8 = new Uint8Array(len);
      var nextIndex = 0;
      for (i = 0; i < arr.length; ++i) {
        u8.set(arr[i], nextIndex);
        nextIndex += arr[i].byteLength;
      }
      return u8;
    }
    static Bytes(buffer) {
      return new Uint8Array(buffer);
    }
    static ab2str = ab2str
    static str2ab = str2ab
    static Uint8ArrayToString = Uint8ArrayToString
    static stringToUint8Array = stringToUint8Array
    static mergeArrayBuffer = mergeArrayBuffer
  }

  Messge.prototype.buffer = function () {
    return this.buffer
  }

  return Messge
}))