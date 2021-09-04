/**
 * Tks https://github.com/skybosi/kudp
 */
import {
  BROAD, MULTI, BEGIN, DOING, DONED, BDD,
  ABROAD, AMULTI, ABEGIN, ADOING, ADONED, ABDD,
} from '../lib/kupack'

import { LAN_PACK_SIZE, WAN_PACK_SIZE, } from '../lib/constant';

(function (root, factory) {
  'use strict'
  if (typeof define === 'function' && define.amd) define([], factory)
  else if (typeof exports === 'object') module.exports = factory()
  else root.kudper = factory()
}(this, function () {
  'use strict'

  const File = require('./file')
  const cache = require('./cache')
  const kudp = require('../lib/kudp').kudp
  const utils = require('../lib/common/utils')
  const ByteStream = require('../../stream/stream').ByteStream
  const WriteStream = require('../../stream/stream').WriteStream

  const IDLEN = 5
  const IDMAX = Math.pow(10, IDLEN)
  const EXPIRE = 60000 // 60s

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

  // 业务基于kudp 实现业务功能
  class kudper {
    constructor(port, event) {
      // 用于与业务层的事件通知，将通知上报到业务层
      this.event = event;
      this.online = { length: 0 };
      this.kudp = new kudp(port, {
        onRead: this.recvFrom.bind(this),
        onStat: this.statist.bind(this),
        onWerr: (...args) => {
          console.error("kudper onErrs", ...args);
          wx.showToast({
            title: '网络有点小问题',
            icon: 'loading'
          });
        },
        onWdone: (...args) => {
          console.log("kudper onWdone:", ...args);
        },
        onRdone(...args) {
          console.log("kudper onRdone:", ...args);
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
      console.log("addOnline +++: ", this.online[id]);
      return this.online[id];
    }

    // 删除下线用户id
    _delOnline(id) {
      let one = this.online[id];
      if (one) {
        delete this.online[id];
        delete this.online[one.address];
        this.online.length--;
        console.log("delOnline --: ", one);
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
          one = this._addOnline(data.message, data.ip, data.port);
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
      let one = this._addOnline(data.message, data.ip, data.port);
      if (data.message == this.id) {
        one.id = this.id;
        data.id = this.id;
        data.type = "LOCAL"
        this.event.emit("onMessage", data);
      } else {
        // 向新上线的用户推送所有在线
        this.kudp.sync(data.ip, data.port, '+' + this.id);
      }
      return one;
    }

    // 处理多播情况 TODO
    _handleMulti(data) {
      // 此时message 是当前上线的用户id
      let one = this._addOnline(data.peerId, data.ip, data.port);
      // 如果是本设备
      if (data.peerId == this.id) {
        data.id = this.id;
        this.event.emit("onMessage", data);
      } else {
        // 向新上线的用户推送所有在线
        this.kudp.sync(data.ip, data.port, '+' + this.id);
      }
    }

    // 处理不同的数据内容类型
    _handleContentType(content_type, data) {
      // console.debug("compare1:", this.ori)
      // console.debug("compare2:", data.message)
      console.log("compare:", this.ori == data.message)
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

    sendTo(fd, payload) {
      let self = this;
      let peer = this.kudp.fstat(fd);
      let PACK_SIZE = utils.IsLanIP(peer.ip) ? WAN_PACK_SIZE : LAN_PACK_SIZE;
      let buff = new ByteStream(WORD + payload);
      let psize = buff.length;
      let times = Math.ceil(psize / PACK_SIZE);
      console.debug("sendTo:", psize)
      let i = 0
      while (true) {
        let data = buff.slice(i * PACK_SIZE, (i + 1) * PACK_SIZE + 1);
        let flag = (i === 0) ? BEGIN : (i + 1 == times ? DONED : DOING);
        self.kudp.write(fd, peer.ip, peer.port, data, flag);
        if (flag == DONED) {
          break
        }
        i++
      }
      return 0;
    }

    recvFrom(ip, port, mtype, RqID, seq, payload) {
      let message = payload
      let data = { ip, port, RqID, seq, message };
      // 数据传输类型
      switch (mtype) {
        case BROAD:
          console.log("online", this.online);
          data.message = data.message.toString();
          this._handleSync(data);
          break;
        case MULTI:
          data.message = data.message.toString();
          this._handleMulti(data);
          break;
        case BEGIN: case DOING: case DONED:
          if (!this.pool[RqID]) {
            this.pool[RqID] = {}
            this.pool[RqID]['content_type'] = payload.read(0, 1);
            this.pool[RqID]['content'] = payload.slice(1);
            this.log = new WriteStream(RqID, {
              flags: 'w+',
              mode: 0o666,
              autoClose: true,
              start: 0,
            })
            this.log.write(payload.slice(1));
          } else {
            this.pool[RqID]['content'] = ByteStream.concat([this.pool[RqID]['content'], payload]);
            this.log.write(payload.slice(1));
          }
          if (DONED === mtype) {
            var file = new File('fdjkudptmp' + Math.ceil(Math.random() * 1000));
            file.write(this.pool[RqID]['content']);
            file.close();
            // let a = file.read();
            data.message = this.pool[RqID]['content'].toString();
            this._handleContentType(this.pool[RqID]['content_type'].toString(), data);
            delete this.pool[RqID];
          }
          break;
        case BDD:
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
      console.log("sendFile: ", fd, path, ip, port)
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
        // console.log(key, stat.props[key]);
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