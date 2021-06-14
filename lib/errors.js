// TODO: errcode
const EKUDPOK = 0
/** 1 ~ 20 udp相关过程中的错误 **/
const EUDPSUPPORT = 1      // Can not support udp function 不支持udp的功能
const EUDPCREATE = 2       // udp create error udp的create错误
const EUDPBIND = 3         // udp bind error udp的bind错误
const EAGAIN = 11          // Resource temporarily unavailable

/** 20 ~ 30 kudp发送过程中造成的异常 **/
const EHEADERTYPE = 20     // 无效数据包header类型
const ENOTALLOCISN = 23    // 无法分配到合适的isn
const EALLOCISNERR = 24    // isn分配异常
/** 30 ~ 40 kudp接收过程中造成的异常 **/
const EBADFD = 77          // File descriptor in bad state 文件描述符状态错误
/** 200 ~ 255 未知错误 **/
const EUNKONWN = 255

const Errors = (code, msg) => {
  return { code: code, msg: msg };
}

export {
  Errors,

  EKUDPOK,
  EUDPSUPPORT,
  EUDPCREATE,
  EUDPBIND,
  EAGAIN,
  EHEADERTYPE,
  ENOTALLOCISN,
  EALLOCISNERR,
  EBADFD,
  EUNKONWN,
};