const suffix = ':suffix';

const getTimestamp = () => {
  return new Date().getTime()
}

const get = (k, def) => {
  var deadtime = parseInt(wx.getStorageSync(k + suffix))
  if (isNaN(deadtime) || deadtime < getTimestamp()) {
    return def;
  }
  return wx.getStorageSync(k) || def;
}

const remove = (k) => {
  wx.removeStorageSync(k + suffix);
  wx.removeStorageSync(k);
}

const set = (k, v, expiry, xnx) => {
  let status = 'OK';
  expiry = parseInt(expiry);
  let flag = isNaN(expiry) ? 'nm' : 'ex';
  flag = xnx || flag;
  switch (flag) {
    case 'nm': // 不存在过期时间, 正常情况
      wx.setStorageSync(k, v)
      break;
    case 'ex': // 存在过期时间
      wx.setStorageSync(k, v)
      if (!isNaN(expiry) && expiry > 0) {
        wx.setStorageSync(k + suffix, getTimestamp() + expiry)
      } else {
        wx.removeStorageSync(k + suffix)
      }
      break;
    case 'nx': // 不存在才写入
      if (!get(k)) {
        wx.setStorageSync(k, v)
        if (!isNaN(expiry) && expiry > 0) {
          wx.setStorageSync(k + suffix, getTimestamp() + expiry)
        } else {
          wx.removeStorageSync(k + suffix)
        }
      } else {
        status = "ERR"
      }
      break;
    case 'xx': // 存在才写入
      if (get(k)) {
        wx.setStorageSync(k, v)
        if (!isNaN(expiry) && expiry > 0) {
          wx.setStorageSync(k + suffix, getTimestamp() + expiry)
        } else {
          wx.removeStorageSync(k + suffix)
        }
      } else {
        status = "ERR"
      }
      break;
    default:
      wx.setStorageSync(k, v)
      break;
  }
  return status
}

const clear = () => {
  wx.clearStorageSync();
}

module.exports = {
  set: set,
  get: get,
  clear: clear,
  remove: remove,
}