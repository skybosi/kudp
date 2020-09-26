const formatTime = date => {
  const year = date.getFullYear()
  const month = date.getMonth() + 1
  const day = date.getDate()
  const hour = date.getHours()
  const minute = date.getMinutes()
  const second = date.getSeconds()

  return [year, month, day].map(formatNumber).join('/') + ' ' + [hour, minute, second].map(formatNumber).join(':')
}

const formatNumber = n => {
  n = n.toString()
  return n[1] ? n : '0' + n
}

const regexIP = /\b((25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\b/;

const isIP = (ip) => {
  return regexIP.test(ip);
}
/**
 * Parses IPv4 to Integer
 * @param  {String}   ip  [valid IPv4 string]
 * @return {Integer}      [Integer value of IPv4 provided]
 */
const ip2Int = (ip) => {
  if (!ip) {
    throw new Error('E_UNDEFINED_IP');
  }

  if (!regexIP.test(ip)) {
    throw new Error('E_INVALID_IP');
  }

  /*
    String value 189.170.79.173
    Integer	3182055341
    To convert an IP address to integer, break it into four octets.
    For example, the ip address you provided can be broken into
    First Octet:	189
    Second Octet:	170
    Third Octet:	79
    Fourth Octet:	173
    To calculate the decimal address from a dotted string, perform the following calculation.
    = (first octet * 256³) + (second octet * 256²) + (third octet * 256) + (fourth octet)
    =	(first octet * 16777216) + (second octet * 65536) + (third octet * 256) + (fourth octet)
    =	(189 * 16777216) + (170 * 65536) + (79 * 256) + (173)
    =	3182055341
    Reference http://www.aboutmyip.com/AboutMyXApp/IP2Integer.jsp
  */
  return ip.split('.').map((octet, index, array) => {
    return parseInt(octet) * Math.pow(256, (array.length - index - 1));
  }).reduce((prev, curr) => {
    return prev + curr;
  });
}

/**
 * Parses Integer to IPv4
 *
 * @param  {String} value [value to parse]
 * @return {String}       [IPv4 String of value provided]
 */
const int2Ip = (value) => {
  if (!value) {
    throw new Error('E_UNDEFINED_INTEGER');
  }
  const result = /\d+/.exec(value);
  if (!result) {
    throw new Error('E_INTEGER_NOT_FOUND');
  }
  value = result[0];
  return [
    (value >> 24) & 0xff,
    (value >> 16) & 0xff,
    (value >> 8) & 0xff,
    value & 0xff
  ].join('.');
}

/**
 * 生成随机数字，前闭后开区间
 * @param {Number} lower 
 * @param {Number} upper 
 */
const randomNum = (lower, upper) => {
  return lower <= upper ? Math.floor(Math.random() * (upper - lower)) + lower : -1;
}

/**
 * 获取当前时间戳
 */
const getTimestamp = () => {
  return new Date().getTime()
}

/**
 * 数字前补0转换为字符串
 * @param {Number} num 
 * @param {Number} n 
 */
const pad = (num, n) => {
  let str = String(num) || 0;
  return Array(str.length >= n ? 0 : n - str.length + 1).join('0') + str;
}

/**
 * arrayBuffer转string
 * @param {*} arrayBuffer 
 */
const newAb2Str = arrayBuffer => {
  let unit8Arr = new Uint8Array(arrayBuffer);
  let encodedString = String.fromCharCode.apply(null, unit8Arr),
    decodedString = decodeURIComponent(escape((encodedString))); //没有这一步中文会乱码
  return decodedString;
}

/**
 *
 * 16位整数转16进制字节码
 * @number 数字number
 * @return 字符串 形如：'FFFFFFFF'
 *
 */
const uint16ToHexString = (number) => {
  let ret = [];
  let string = '0';
  if (typeof number === 'string') {
    const {
      hexString
    } = PMQTPTools.writeUTF8(number);
    string = hexString.substr(0, 2);
  } else {
    string = number.toString(16);
  }

  const length = string.length;

  for (let i = length; 4 - i > 0; i++) {
    ret.push('0');
  }

  if (length <= 4) {
    ret.push(string);
  } else {
    ret.push(string.substr(-4));
  }

  return ret.join('');
}

/**
 *
 * 标准CRC16校验码
 * @decimalBytes 输入十进制的字节数组
 * @return  返回uint16的数字
 *
 * demo
 *    const {decimalBytes} = PMQTPTools.transToUTF8('123456789');
 *      let crc = PMQTPTools.crc16(decimalBytes);
 *      hexCRC = PMQTPTools.uint16ToHexString(crc);
 *      console.log(hexCRC); // 29b1
 *
 */
const crc16 = (decimalBytes) => {
  let crc = 0xFFFF;

  let tabccitt = [];
  for (let i = 0; i < 256; i++) {

    let ccitt = 0;
    let c = i << 8;

    for (let j = 0; j < 8; j++) {

      if ((ccitt ^ c) & 0x8000) {
        ccitt = (ccitt << 1) ^ 0x1021;
      } else {
        ccitt = ccitt << 1;
      }

      c = c << 1;
    }

    tabccitt.push(uint16ToHexString(ccitt));
  }

  for (let number of decimalBytes) {

    const sc = 0x00FF & number;
    const index = (0xFFFF) & ((crc >>> 8) ^ sc);

    const n = Number.parseInt(tabccitt[index], 16);
    crc = (0xFFFF) & ((0xFFFF) & (crc << 8)) ^ ((0xFFFF) & n);
  }

  return crc;
}

/**
 * let bool = true;
 * let num = 1;
 * let str = 'abc';
 * let und = undefined;
 * let nul = null;
 * let arr = [1,2,3,4];
 * let obj = {name:'xiaoming',age:22};
 * let fun = function(){console.log('hello')};
 * let s1 = Symbol();
 * Object.prototype.toString.call(bool);//[object Boolean]
 * Object.prototype.toString.call(num); //[object Number]
 * Object.prototype.toString.call(str); //[object String]
 * Object.prototype.toString.call(und); //[object Undefined]
 * Object.prototype.toString.call(nul); //[object Null]
 * Object.prototype.toString.call(arr); //[object Array]
 * Object.prototype.toString.call(obj); //[object Object]
 * Object.prototype.toString.call(fun); //[object Function]
 * Object.prototype.toString.call(s1);  //[object Symbol]
 */
const Type = (obj) => {
  return Object.prototype.toString.call(obj).slice(8, -1)
}

/**
 * 是否是局域网IP
 */
const IsLanIP = (ip) => {
  return (ip.substr(0, 3) == "10." ||
    ip.substr(0, 4) == "192." ||
    ip.substr(0, 4) == "172."
  ) ? true : false;
}


module.exports = {
  Pad: pad,
  Type: Type,
  Crc16: crc16,
  IsIP: isIP,
  Int2Ip: int2Ip,
  Ip2Int: ip2Int,
  IsLanIP: IsLanIP,
  NewAb2Str: newAb2Str,
  RandomNum: randomNum,
  FormatTime: formatTime,
  GetTimestamp: getTimestamp,
}