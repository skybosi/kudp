/**
 * 发送器
 * 业务层调用发送的接口，通过udp发送到对端，必要时做出重试，目的是保证数据可靠到达
 * 在一次单向的发送 <--> 接收 的过程中
 * 发送方：仅仅只会发送 BROAD ~ BDD
 * 接收方：仅仅只会发送 ABROAD ~ ABDD
 * 对于发送器来说，只会发送数据包，在超时时做出重试，此外是等待ACK，对资源做释放处理，对应的资源有：
 *   - fd 分配：标记一次传输过程的关联符号，open 创建 close 释放
 *   - seq 管理器：标记一次传输数据包的唯一标识，在一个数据块内可能在数据包较大时重复，但是在多个数据块之间禁止交叉重复。
 *   - timer 定时器：超时重试的定时功能，在ack后会被释放
 *
 * 概念:
 * - 数据块级别：表示一次独立的完整传输过程，比如一张图片，一段文本，一个视频，由被分离的数据包组装而成，必须包含 BEGIN -> DOING -> DONED / BDD 的数据包类型
 * - 发送器级别：一个完整的发送器等级，发送器可以同时支持发送多个不同的独立数据块传输（数据块级别），比如一段文字、一张图片 可以同时传输
 *
 * 关键成员功能作用:
 *
 * - timers: 发送器级别，管理所有发送的数据包的序号及其重试处理，以确保数据超时重试，且在收到ACK时释放，还有在重试超过某一限制时将会向发送方的业务层抛出错误，对应onErrs回调
 * - conn: 发送器/数据块级别，连接器，用于数据块传输过程中的发送方的seq的管理中心，用于标识定位发送的数据包是属于哪个数据块。
 * - seqer: 发送器级别，seq 管理器，用于在需要的时候分配和生成以及ACK时的释放，是数据块之间分组的核心模块。存在攻击风险。 TODO：优化管理效率，谨防恶意攻击
 * - stat: 发送器级别，发送的过程中统计信息，用于流控做分析准备，简单的限流工具.
 * - timeout, delta: 发送器级别，简单的限流工具，通过多次传输过程 send -> ack 之间的耗时均值，加上一个delta，作为后期的timer的timeout。
 * - repeat: 数据块级别，超时重试次数，超过该次数将会上抛异常回调。
 * 
 * 公开的kudp层回调接口:
 * - onSend: 数据块级别，数据包准备好，可以发送时的回调，用于屏蔽具体发送方式，上层觉得操作方法。
 * - onErrs: 数据块级别，单次传输超时时的重试次数，超过时将回调该函数，用户方便业务层异常提示，阈值为 repeat
 * - onDone: 数据块级别，数据块发送完成时的回调。
 *
 */
import {
  BROADWAY, DEFAULT_PORT, PROTONAME, FD_BROAD, FD_MULTI,
  VERSION, SEP, ACK_TIMEOUT, LAN_PACK_SIZE, WAN_PACK_SIZE,
} from './constant';

import {
  BROAD, MULTI, BEGIN, DOING, DONED, BDD,
  ABROAD, AMULTI, ABEGIN, ADOING, ADONED, ABDD,
} from './kupack'

import { Errors, EHEADERTYPE, EBADFD, } from './errors';

(function (root, factory) {
  'use strict'
  if (typeof define === 'function' && define.amd) define([], factory)
  else if (typeof exports === 'object') module.exports = factory()
  else root.Sender = factory()
}(this, function () {
  const kupack = require('./kupack').Package
  const SeqManage = require('./seq')
  const Queue = require('./sendQueue')

  const Stat = require('./common/Stat')
  const utils = require('./common/utils')
  const BitSet = require('./common/BitSet')
  const Buffer = require('./common/Buffer/Buffer')

  const FACTOR = 4     // 默认放大因子
  const BASE_SECTION = 256 // 基础段长度
  const KUDP_SNDBUF = FACTOR * BASE_SECTION // 4194304 // 4 * 1024 * 1024 byte
  const RETRY = 100    // 重试次数
  const ACK_PAYLOAD = ''

  /**
   * create a new fd while open a new connect
   */
  class Fd {
    constructor(size) {
      // 初始化一个默认1024比特的bitset,其中0、1、2、3、4被默认占用
      this.fdset = new BitSet("31,0," + (size || 1024));
      // 每个bit位的附加信息
      this.fdinfo = {};
      this.init();
    }

    /**
     * 初始化几个固定的bit位的信息
     */
    init() {
      this.setBit(FD_BROAD, {
        fd: FD_BROAD,
        flag: BROAD,
        ip: BROADWAY,
        port: DEFAULT_PORT,
        time: +new Date,
      });
      this.setBit(FD_MULTI, {
        fd: FD_MULTI,
        flag: MULTI,
        port: DEFAULT_PORT,
        time: +new Date,
      });
    }

    /**
     * 获取一个合适fd，同时绑定相关信息
     * @param {*} info 
     */
    setInfo(info) {
      let fd = this.getfd();
      info.fd = fd;
      this.setBit(fd, info);
      return fd;
    }

    /**
     * 为一个已经设置过数据的fd添加属性。
     * @param {*} fd 
     * @param {*} info 
     */
    addInfo(fd, info) {
      this.fdinfo[fd] = Object.assign((this.fdinfo[fd] || {}), info)
    }

    /**
     * 获取最小一个0的位置作为下一个可分配的fd
     */
    getfd() {
      let fd = this.fdset.ffz();
      if (fd < 0) {
        throw Errors(EBADFD, "bad fd");
      }
      this.fdset.set(fd);
      return fd
    }

    /**
     * 设置bit附属信息
     * @param {*} fd 
     * @param {*} info 
     */
    setBit(fd, info) {
      this.fdinfo[fd] = info;
    }

    /**
     * 释放一个fd，同时回收bit
     * @param {*} fd 
     */
    close(fd) {
      this.fdset.unset(fd);
      delete this.fdinfo[fd];
    }

    /**
     * 获取bit对应的附属属性
     * @param {*} fd 
     */
    getInfo(fd) {
      return this.fdinfo[fd];
    }
    static testFd() {
      var fdset = new Fd("0,99");
      let i = 0
      while (i++ < 1000) {
        fdset.setInfo({ [i]: i });
      }
      i = fdset.fdset.ffz();
      while (i-- >= 0) {
        fdset.close(i);
      }
    }
  }

  /**
   * 虚拟连接器，管理和维护 发送 <---> 接收 两端的一次数据块，保证在这次传输过程中的唯一标识的，
   * 同时管理多个连接之间的传输细节
   */
  class Connector {
    constructor() {
      /**
       * 0 1 2 标准输入 标准输出 标准错误
       * 3 广播数据包 占用
       * 4 多播数据包 占用
       * 传输数据从5 开始使用
       */
      this.fds = new Fd();
    }

    /**
     * 新建一次新的传输过程，分配一个唯一的fd
     * @param {*} option 
     */
    open(option) {
      option = Object.assign((option || {}), { time: +new Date })
      let fd = this.fds.setInfo(option);
      return fd;
    }

    /**
     * 关闭一次传输, 释放对应的fd
     * @param {*} fd 
     */
    close(fd) {
      this.fds.close(fd);
    }

    /**
     * 通过fd获取对应的信息
     * @param {*} fd 
     */
    fstat(fd) {
      return this.fds.getInfo(fd);
    }

    /**
     * 添加ip信息
     * @param {*} fd 
     * @param {*} option 
     */
    addInfo(fd, option) {
      this.fds.addInfo(fd, option)
    }

    /**
     * 清除信息
     * @param {*} fd 
     */
    clearInfo(fd) {
      this.fds.setBit(fd, { time: +new Date });
    }
  }

  /**
   * 发送器，每一个时刻只针对一个接收者，对于另外一个接收者将会创建一个独立的发送器以及背后的发送缓冲区
   * 功能范围：
   * 1. 接收应用层的发送任务
   * 2. 编码发送的数据为协议数据包
   * 3. 管理虚拟链接
   * 4. 管理发送队列：超时重试，ack释放
   */
  const S_PREFIX = [PROTONAME, VERSION, 'sender'].join(SEP)
  class Sender {
    constructor(options) {
      for (var prop in this.defaultOptions) this[prop] = this.defaultOptions[prop]
      this.delta = 10;
      this.timers = {};               // 重试定时器
      this.stat = new Stat();         // 统计分析模块
      this.conn = new Connector();    // 虚拟连接器
      this.seqer = new SeqManage();   // seq 管理器   
      this.queue = null;              // 并发传输多个数据块的处理队列
      this.initOptions(options);
    }

    defaultOptions = {
      onSend: () => { },    // 准备发送数据
      onErrs: () => { },    // 重试次数过多异常
      onDone: () => { },    // 数据块发送完成
      rto: ACK_TIMEOUT, // 重试的超时时间
      repeat: 10,           // 发送超时最大次数，超过时将报错，回调onErrs
    }

    /**
     * 初始化cb options
     * @param {*} option 
     * @param {*} value 
     */
    initOptions(option, value) {
      if (option && value) this[option] = value
      if (!value && typeof option === 'object') {
        for (var prop in option) {
          if (this.defaultOptions.hasOwnProperty(prop) && this.hasOwnProperty(prop))
            this[prop] = option[prop]
        }
      }
      return this
    }


    /********************** 外部函数 **********************/

    /**
     * 新建一次新的传输过程，分配一个唯一的fd
     * @param {*} ip 
     * @param {*} port 
     * @param {*} option 
     */
    open(ip, port, option) {
      let fd = this.conn.open({ ip, port, option })
      let meta = { fd: fd, name: S_PREFIX }
      this.queue = new Queue(ip, port, meta); // 并发传输多个数据块的处理队列
      return fd;
    }

    /**
     * 关闭一次传输, 释放对应的fd
     * @param {*} fd 
     */
    close(fd) {
      this.conn.close(fd);
    }

    /**
     * 释放重试定时器, 释放seq段， mtype >= ABOARD
     * @param {*} task_seq 
     * @param {*} mtype 
     * @param {*} peerInfo 
     */
    free(task_seq, mtype, peerInfo) {
      let { task, seq, task_info } = this.taskSeq(task_seq)
      let isn = task_info['isn']
      if (mtype > AMULTI) {
        let ATask = this.taskQueue(task)
        let ATaskQ = ATask['Q']
        let ATaskMeta = ATask['meta']
        let ATaskTimer = ATask['timer']
        // 删除累计确认过程中的所有seq
        if (ATask && ATaskQ && !ATaskQ.empty()) {
          ATaskQ.free(seq, (node) => {
            let { stime, mtype } = node
            node && this.calcRto(stime);
            if (mtype == BDD) {
              ATaskTimer && ATaskTimer.setArgs({ done: 1 });
            }
          })
          console.info("free ack seq ok isn, seq:", isn, seq);
        }
        // 队列为空，且已经收到结束数据包，释放定时器
        if (ATaskQ.empty()) {
          if (1 === (ATaskTimer.args || {}).done) {
            let { fd } = ATaskMeta
            this.conn.clearInfo(fd);
            if (ABEGIN !== mtype && ADOING !== mtype) {
              this.seqer.free(task);   // 释放seq
              this.queue.remove(task); // 释放queue
              this.onDone(isn, mtype, peerInfo, this.stat, this);
            }
          }
        }
      } else {
        // TODO
        // 对应 addSeqQueue 的 case BROAD: case MULTI:
        // 删除发送窗口中的分配的序号
        if (isn >= 0) {
          this.seqer.free(isn); // isn
          this.onDone(isn, mtype, peerInfo, this.stat, this);
        }
      }
    }

    /**
     * 向某个ip:port发送类型mtype的消息data
     * @param {*} fd 
     * @param {*} ip 
     * @param {*} port 
     * @param {*} mtype 
     * @param {*} payload 
     */
    send(fd, ip, port, mtype, payload) {
      let body = null;
      if (mtype < ABROAD) {
        let PACK_SIZE = utils.IsLanIP(ip) ? WAN_PACK_SIZE : LAN_PACK_SIZE;
        body = this.encode(fd, mtype, payload, PACK_SIZE);  // 编码数据包
      } else {
        body = this.encodeAck(mtype, payload, ACK_PAYLOAD);          // 编码数据包ACK
      }
      let { seq, size, type, pack } = body;
      // 发送缓冲区溢出异常
      if (0 > size) return { size: size, seq: seq, mtype: type };
      this.onSend(mtype, ip, port, pack.buffer);
      this.addSeqTimer(seq, type, ip, port, pack, fd);
      return { size: size, seq: seq, mtype: type };
    }

    /**
     * 通过fd获取对应的信息
     * @param {*} fd 
     */
    fstat(fd) {
      return this.conn.fstat(fd);
    }

    /********************** 内部函数 **********************/

    /**
     * 编码转换为ArrayBuffer类型，如果必要的话
     * @param {*} payload 
     */
    _encoding(payload) {
      return Buffer.isBuffer(payload) ? payload : Buffer.from(payload || '');
    }

    /**
     * 编码及生成seq，根据传输过程和payload调整数据包类型
     * @param {*} fd 
     * @param {*} mtype 
     * @param {*} payload 
     * @param {*} max_size 
     */
    encode(fd, mtype, payload, max_size) {
      let seq = 0, overflow = false;
      let buff = this._encoding(payload);
      let psize = buff.length;
      if (buff && psize > max_size) {
        overflow = true;
        buff = buff.slice(0, max_size);
      }
      let size = buff.length;
      let fstat = this.fstat(fd);
      if (!fstat) {
        throw Errors(EBADFD, "bad or empty fd", fd);
      }

      // 根据数据类型，改写mtype
      if (mtype === BEGIN) {
        // 首个数据包，将申请一个新的isn
        if (fstat && !fstat.isn) {
          /**
           * 消息数据包（小于PACK_SIZE），只用占用一个数据包, 即 BDD
           * 否则为 BEGIN， 标记一个数据块的其实数据包。
           */
          mtype = overflow ? BEGIN : BDD;
        } else {
          /**
           * size == max_size 传输过程数据包
           * size <  max_size 传输到最后一个数据包
           */
          mtype = (overflow && size == max_size) ? DOING : DONED;
        }
      }
      // 根据数据包类型，分配seq
      switch (mtype) {
        case BEGIN:
          seq = this.seqer.malloc();
          fstat['isn'] = seq;
          break;
        case BDD: case BROAD: case MULTI:
          seq = this.seqer.malloc(1);
          fstat['isn'] = seq;
          break;
        case DOING: case DONED:
          // // 检测当前连接发送缓冲区是否已满
          // if (this.checkBufferFull(fstat['isn']))
          //   return { size: -1, type: mtype };
          seq = this.seqer.next(fstat['isn']);
          break;
        default:
          throw Errors(EHEADERTYPE, "invalid type", type);
      }
      let pack = new kupack(mtype, 0, 1, seq, buff);
      return { seq: seq, size: size, type: mtype, pack: pack }
    }

    /**
     * 生成对应ack包
     * @param {*} mtype 
     * @param {*} seq 
     * @param {*} payload 
     */
    encodeAck(mtype, seq, payload) {
      let buff = this._encoding(payload);
      let pack = new kupack(mtype, 0, 1, seq, buff);
      return { seq: seq, size: buff.length, type: pack.header.Type(), pack: pack }
    }


    /**
     * 定时器超时重传数据包
     * @param {*} task 
     * @param {*} ip 
     * @param {*} port 
     */
    retry(task, ip, port) {
      // TODO 防止死循环，导致无限重试
      let ATask = this.taskQueue(task)
      let ATaskQ = ATask['Q']
      if (ATask && ATaskQ && !ATaskQ.empty()) {
        let ATaskTimer = ATask['timer']
        if (ATaskTimer.repeat >= this.repeat) {
          ATaskTimer.stop();
          this.onErrs(task, { address: ip, port: port }, this);
          return
        }
        // 发送待确认队列中的残余数据
        ATaskQ.each((data) => {
          let { mtype, pack } = data
          data.stime = +new Date;
          this.onSend(mtype, ip, port, pack.buffer, 1);
        })
        if ("stopped" == ATaskTimer.status) {
          ATaskTimer.restart(this.rto);
        }
      } else {
        console.log("retry invalid paramete!!!");
      }
    }

    /**
     * 将发送出去的数据包添加seq重试定时器
     * @param {*} task_seq 
     * @param {*} mtype 
     * @param {*} ip 
     * @param {*} port 
     * @param {*} pack 
     * @param {*} fd 
     */
    addSeqTimer(task_seq, mtype, ip, port, pack, fd) {
      let { task, seq, task_info } = this.taskSeq(task_seq)
      let isn = task_info['isn']
      switch (mtype) {
        case BEGIN: case BDD:
          let cap = (mtype === BEGIN) ? KUDP_SNDBUF : 1;
          let data = { mtype, pack, task, isn, fd, ip, port, stime: +new Date }
          let ATask = this.queue.insert(task, cap, data, this.retry.bind(this));
          if (ATask) {
            ATask['timer'].start(this.rto)  // 启动单个发送任务定时器
          }
          return
        case DOING: case DONED:
          break;
        case BROAD: case MULTI: // TODO: 广播，多播 是否需要重传？
          return;
        default:
          return;
      }
      let ATask = this.taskQueue(task)
      let ATaskQ = ATask['Q']
      if (ATask && ATaskQ) {
        let data = { mtype, pack, task, isn, fd, ip, port, stime: +new Date }
        ATaskQ.push(task, seq, data);  // TODO 是否存在 ip, port 错乱
        if (mtype === DONED) {
          let ATaskTimer = ATask['timer']
          ATaskTimer && ATaskTimer.setArgs({ done: 1 });
        }
      } else {
        console.error("addSeqQueue empty");
      }
    }

    /**
     * 计算rto  RFC1122 RFC6298 RFC2988, 动态调整定时器超时时间
     * @param {*} tm 
     * @param {*} delta 
     */
    calcRto(tm, delta) {
      let rtt = +new Date - tm; // Math.ceil((+new Date - tm + ACK_ECHO_TIMEOUT) / delta);
      let LBOUND = 100, UBOUND = 60000, rto = ACK_TIMEOUT;
      if (!this.srtt || this.srtt == 0) {
        this.srtt = rtt;
        this.rttvar = rtt >> 1;
      } else {
        let delta = rtt - this.srtt;
        if (delta < 0) {
          delta = -delta;
        }
        this.rttvar = (3 * this.srtt + delta) >> 2;
        this.srtt = (7 * this.srtt + rtt) >> 3;
      }
      rto = this.srtt + 4 * this.rttvar;
      this.rto = Math.min(UBOUND, Math.max(LBOUND, rto))
      // console.info("calcRto", tm, this.rto);
      return this.rto
    }

    /**
     * 获取发送队列的详细信息
     * @param {*} task 
     */
    taskQueue(task) {
      return this.queue.location(task)
    }

    /**
     * 根据网络数据中的task_seq获取发送task seq的详细
     * @param {*} task_seq 
     */
    taskSeq(task_seq) {
      return this.seqer.location(task_seq)
    }
  }
  return Sender;
}))
