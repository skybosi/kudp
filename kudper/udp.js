/**
 * Tks https://github.com/skybosi/kudp
 */
(function (root, factory) {
  'use strict'
  if (typeof define === 'function' && define.amd) define([], factory)
  else if (typeof exports === 'object') module.exports = factory()
  else root.kudper = factory()
}(this, function () {
  'use strict'

  const File = require('./file')
  const cache = require('./cache')
  const kudp = require('../lib/kudp')
  const utils = require('../lib/common/utils')
  const Buffer = require('../lib/common/Buffer/Buffer')

  const IDLEN = 5
  const IDMAX = Math.pow(10, IDLEN)
  const EXPIRE = 60000 // 60s

  var LOG = {}
  LOG.level_ = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3,
    fatal: 4
  }
  LOG.level = 'info';
  LOG.func = function (funcName) {
    return function (...msg) {
      if (LOG.level_[funcName] < LOG.level_[LOG.level]) { return; }
      if (console && console[funcName]) {
        console[funcName](...msg);
      }
    };
  };
  LOG.warn = LOG.func('warn');
  LOG.debug = LOG.func('log');
  LOG.error = LOG.func('error');
  LOG.info = LOG.func('info');


  const WORD = '0'   // ascii byte 48
  const TEXT = '1'   // ascii byte 49
  const IMAGE = '2'  // ascii byte 50
  const AUDIO = '3'  // ascii byte 51
  const VIDEO = '4'  // ascii byte 51

  const MsgType = {
    [WORD]: 'WORD',
    [TEXT]: 'TEXT',
    [IMAGE]: 'IMAGE',
    [AUDIO]: 'AUDIO',
    [VIDEO]: 'VIDEO',
  }

  const rMsgType = {
    "WORD": WORD,
    "TEXT": TEXT,
    "IMAGE": IMAGE,
    "AUDIO": AUDIO,
    "VIDEO": VIDEO,
  }

  // 业务基于kudp 实现业务功能
  class kudper {
    constructor(port, event) {
      // 用于与业务层的事件通知，将通知上报到业务层
      this.event = event;
      this.online = { length: 0 };
      this.kudp = new kudp.kudp(port, {
        onRead: this.recvFrom.bind(this),
        onStat: this.statist.bind(this),
        onWerr: (...args) => {
          LOG.error("kudper onErrs", ...args);
          wx.showToast({
            title: '网络有点小问题',
            icon: 'loading'
          });
        },
        onWdone: (...args) => {
          LOG.info("kudper onWdone:", ...args);
        },
        onRdone(...args) {
          LOG.info("kudper onRdone:", ...args);
        }
      });
      this.id = this.getId();   // 获取随机分配的设备id，用于唯一标识
      this.pool = {};           // 接收数据包池子
      this.init();
    }

    // 初始化各类回调
    init() {
      let self = this
      wx.onNetworkStatusChange(function (res) {
        self.offline()
        wx.showToast({
          title: '网络有点小问题',
          icon: 'loading'
        });
        self.getLocalip(true);
        setTimeout(() => {
          wx.hideToast({
            complete: (res) => { },
          })
        }, 1000)
      })
    }

    // 获取分配的随机id
    getId() {
      let id = null
      try {
        let res = cache.get('LOCAL');
        if (res) {
          id = res
        } else {
          id = utils.RandomNum(0, IDMAX)
          cache.set('LOCAL', id, EXPIRE);
        }
      } catch (e) {
        id = utils.RandomNum(0, IDMAX)
        cache.set('LOCAL', id, EXPIRE);
      }
      id = utils.Pad(id, IDLEN)
      return id
    }

    // 发送上线广播通知
    connect() {
      return this.kudp.broadcast('@' + this.id);
    }
    // 下线广播
    offline() {
      if (this.online[this.id]) {
        return this.kudp.broadcast('-' + this.id);
        // this.upper.close()
      }
    }

    // 添加上线用户id address port
    _addOnline(id, address, port) {
      let one = this.online[id];
      if (!one) {
        this.online.length++;
      }
      this.online[id] = {
        address: address,
        port: port
      };
      this.online[address] = id;
      LOG.info("addOnline +++: ", this.online[id]);
      return this.online[id];
    }

    // 删除下线用户id
    _delOnline(id) {
      let one = this.online[id];
      if (one) {
        delete this.online[id];
        delete this.online[one.address];
        this.online.length--;
        LOG.info("delOnline --: ", one);
      }
      return one;
    }

    // 消息处理方法

    // 处理[SYNC数据包]设备上下线，各设备之间数据同步的功能
    _handleSync(data) {
      let one = null
      data.message = data.message + ''
      let method = data.message[0];
      data.message = data.message.slice(1);
      switch (method) {
        case '@':
          return this._handleLocal(data);
        case '+':
          one = this._addOnline(data.message, data.IPinfo.address, data.IPinfo.port);
          break;
        case '-':
          one = this._delOnline(data.message);
          break;
        default:
          break;
      }
      data.online = this.online.length;
      one && this.event.emit("onMessage", data);
      return data;
    }

    // 处理[LOCAL数据包]设备ip地址获取的功能
    _handleLocal(data) {
      let one = this._addOnline(data.message, data.IPinfo.address, data.IPinfo.port);
      if (data.message == this.id) {
        one.id = this.id;
        data.id = this.id;
        data.type = "LOCAL"
        this.event.emit("onMessage", data);
      } else {
        // 向新上线的用户推送所有在线
        this.kudp.sync(data.IPinfo.address, data.IPinfo.port, '+' + this.id);
      }
      return one;
    }

    // 处理多播情况 TODO
    _handleMulti(data) {
      // 此时message 是当前上线的用户id
      let one = this._addOnline(data.peerId, data.IPinfo.address, data.IPinfo.port);
      // 如果是本设备
      if (data.peerId == this.id) {
        data.id = this.id;
        this.event.emit("onMessage", data);
      } else {
        // 向新上线的用户推送所有在线
        this.kudp.sync(data.IPinfo.address, data.IPinfo.port, '+' + this.id);
      }
    }

    // 处理不同的数据内容类型
    _handleContentType(content_type, data) {
      // LOG.debug("compare1:", this.ori)
      // LOG.debug("compare2:", data.message)
      LOG.info("compare:", this.ori == data.message)
      switch (content_type) {
        case WORD:
          this.event.emit("onMessage", data);
          break;
        case TEXT:
        case IMAGE:
        case AUDIO:
        case VIDEO:
          break;
      }
    }

    // 连接管理
    open(ip, port, flag) {
      return this.kudp.open(ip, port, flag);
    }

    close(fd) {
      return this.kudp.close(fd);
    }

    sendTo(fd, payload, ip, port) {
      this.ori = payload
      let PACK_SIZE = utils.IsLanIP(ip) ? kudp.WAN_PACK_SIZE : kudp.LAN_PACK_SIZE;
      let buff = Buffer.from(WORD + payload);
      let psize = buff.length;
      let times = Math.ceil(psize / PACK_SIZE);
      LOG.debug("sendTo:", psize)
      for (let i = 0; i < times; ++i) {
        let data = buff.slice(i * PACK_SIZE, (i + 1) * PACK_SIZE + 1);
        if (i + 1 === times)
          this.kudp.write(fd, data, ip, port, kudp.DONED);
        else
          this.kudp.write(fd, data, ip, port);
      }
      return 0;
    }

    recvFrom(isn, mtype, seq, peerInfo, payload) {
      let data = {
        isn: isn, seq: seq, message: payload,
        IPinfo: peerInfo, iPint: peerInfo.ipint,
      };
      // 数据传输类型
      switch (mtype) {
        case kudp.BROAD:
          console.info("online", this.online);
          data.message = data.message.toString();
          this._handleSync(data);
          break;
        case kudp.MULTI:
          data.message = data.message.toString();
          this._handleMulti(data);
          break;
        case kudp.BEGIN: case kudp.DOING: case kudp.DONED:
          if (!this.pool[isn]) {
            this.pool[isn] = {}
            this.pool[isn]['content_type'] = payload.read(0, 1);
            this.pool[isn]['content'] = payload.slice(1);
          } else {
            this.pool[isn]['content'] = Buffer.concat([this.pool[isn]['content'], payload]);
          }
          if (kudp.DONED === mtype) {
            var file = new File('fdjkudptmp' + Math.ceil(Math.random() * 1000));
            file.write(this.pool[isn]['content']);
            file.close();
            // let a = file.read();
            data.message = this.pool[isn]['content'].toString();
            this._handleContentType(this.pool[isn]['content_type'].toString(), data);
            delete this.pool[isn];
          }
          break;
        case kudp.BDD:
          this.content_type = payload.read(0, 1);
          payload = payload.slice(1);
          data.message = payload.toString();
          this._handleContentType(this.content_type.toString(), data);
          break;
        default:
          throw new TypeError('header type is invalid:', mtype);
      }
      return;
    }

    sendFile(fd, path, ip, port) {
      LOG.info("sendFile: ", fd, path, ip, port)
    }

    // 工具方法

    // 获取最新的本设备的ip， 默认从缓存获取，否则再次发送广播获取
    getLocalip(forse) {
      if (!forse) {
        return this.online[this.id];
      } else {
        this.connect();
      }
    }

    // 获取本设备信息， 从缓存获取
    getSelf() {
      return this.online[this.id];
    }

    // 获取除本设备的其他所有设备, 如果id存在，即获取对应的信息
    getOthers(id) {
      if (id) {
        return this.online[id] ? [this.online[id]] : null;
      }
      let online = [];
      let copy = Object.assign({}, this.online);
      for (let prop in copy) {
        if (prop != 'length' && 'string' != (typeof copy[prop]) /* && prop != this.id*/) {
          online.push(copy[prop]);
        }
      }
      return online;
    }

    // 统计工具
    statist(type, stat) {
      if ('recv' !== type)
        return;
      let format_str = ""
      for (let key in stat.props) {
        // LOG.info(key, stat.props[key]);
        if ('pgc' == key) {
          format_str = format_str + "\n" + "发送数据包：" + stat.props[key]
        } else if ('rpgc' == key) {
          format_str = format_str + "\n" + "接收数据包：" + stat.props[key]
        } else if ('ackpgc' == key) {
          format_str = format_str + "\n" + "发送确认数据包：" + stat.props[key]
        } else if ('rackpgc' == key) {
          format_str = format_str + "\n" + "接收确认数据包：" + stat.props[key]
        } else if ('dup' == key) {
          format_str = format_str + "\n" + "dup值：" + stat.props[key]
        } else if ('spgc' == key) {
          format_str = format_str + "\n" + "发送小型数据包：" + stat.props[key]
        } else if ('nspgc' == key) {
          format_str = format_str + "\n" + "发送非小型数据包：" + stat.props[key]
        } else if ('rspgc' == key) {
          format_str = format_str + "\n" + "接收小型数据包：" + stat.props[key]
        } else if ('rnspgc' == key) {
          format_str = format_str + "\n" + "接收非小型数据包：" + stat.props[key]
        } else if ('erpgc' == key) {
          format_str = format_str + "\n" + "错误数据包：" + stat.props[key]
        }
      }
      format_str = format_str.slice(1)
      this.event.emit("kudp-stat", format_str);
      return format_str
    }

    // serialize the data
    serialize(data) {
      let type = utils.Type(data);
      switch (type) {
        case "Number": case "String":
          return data;
        case "Array": case "Object":
          return JSON.stringify(data)
        case "Boolean":
          return (data === true) ? 1 : 0;
        case "Undefined": case "Null": default:
          return '';
      }
    }
  }

  return kudper;
}))