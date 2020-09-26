/**
 * 
 * https://github.com/dannnney/weapp-event
 * 一个基本合格的 Event 管理器应该具备怎样的能力？
 *  - 支持多种 Event 的通知
 *  - 支持对某一 Event 可以添加多个监听者
 *  - 支持对某一 Event 可以移除某一监听者
 *  - 将 Event 的存储和管理放在一个单独模块中，可以被所有文件全局引用
 * 根据以上的描述，我们来设计一个新的 Event 模块，对应上面的能力，它应该具有如下三个函数：
 *  - on函数: 用来向管理器中添加一个 Event 的 Callback，且每一个 Event 必须有全局唯一的 EventName，函数内部通过一个数组来保存同一 Event 的多个 Callback
 *  - on1函数: 用来向管理器中添加一个 Event 的 Callback，且每一个 Event 必须有全局唯一的 EventName，且只保留最新的一个
 *  - remove函数: 用来向管理器移除一个 Event 的 Callback
 *  - emit函数: 用来触发一个 Event 
 *  - once函数: 用来触发一个 Event，且执行一次，将删除事件处理函数
 * 
 */
var events = {};

function on1(name, self, callback) {
  if (!name) return
  events[name] = [
    [self, callback]
  ];
}

function on(name, self, callback) {
  if (!name) return
  var tuple = [self, callback];
  var callbacks = events[name];
  if (Array.isArray(callbacks)) {
    callbacks.push(tuple);
  } else {
    events[name] = [tuple];
  }
}

function remove(name, self) {
  if (!name) return
  var callbacks = events[name];
  if (Array.isArray(callbacks)) {
    events[name] = callbacks.filter((tuple) => {
      return tuple[0] != self;
    })
  }
}

function emit(name, data) {
  if (!name) return
  var callbacks = events[name];
  if (Array.isArray(callbacks)) {
    callbacks.map((tuple) => {
      var self = tuple[0];
      var callback = tuple[1];
      callback.call(self, data);
    })
  }
}

function once(name, data) {
  if (!name) return
  var callbacks = events[name];
  if (Array.isArray(callbacks)) {
    callbacks.map((tuple) => {
      var self = tuple[0];
      var callback = tuple[1];
      callback.call(self, data);
      remove(name, self)
    })
  }
}

exports.on = on;
exports.on1 = on1;
exports.remove = remove;
exports.emit = emit;
exports.once = once;