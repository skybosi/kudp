(function (g, f) {
    const e = typeof exports == 'object' ? exports : typeof g == 'object' ? g : {};
    f(e);
    if (typeof define == 'function' && define.amd) {
        define('task', e);
    }
})(this, function (exports) {
    class task {
        constructor(limit, endcb, ...args) {
            this.limit = limit || 2;
            this.tasks = [];// 待运行的任务
            this.running = []; // 正在运行的任务
            this.endcb = endcb;
            this.args = args;
        }

        // promiseCreator 是一个异步函数，return Promise
        // 添加一个任务
        add(promiseCreator) {
            return new Promise((resolve, reject) => {
                promiseCreator.resolve = resolve;
                if (this.running.length < this.limit) {
                    this.run(promiseCreator);
                } else {
                    this.tasks.push(promiseCreator);
                }
            })
        }

        // 执行任务
        run(promiseCreator) {
            this.running.push(promiseCreator);
            promiseCreator().then(() => {
                promiseCreator.resolve();
                this.remove(promiseCreator);
                if (this.tasks.length > 0) {
                    this.run(this.tasks.shift());
                }
            })
        }

        // 删除执行过的任务
        remove(promiseCreator) {
            let index = this.running.findIndex(promiseCreator)
            this.running.splice(index, 1)
            if (this.running.length <= 0) {
                if (typeof this.endcb === 'function') {
                    this.endcb(...this.args);
                }
            }
        }

        // 定时执行
        timeout(time) {
            return new Promise(resolve => {
                setTimeout(resolve, time)
            })
        }

        // 添加一个延时任务
        addTask(time, dofn, ...args) {
            let newfn = "function" !== typeof (dofn) ? console.log : dofn;
            let nargs = "function" !== typeof (dofn) ? dofn : args;
            this.add(() => this.timeout(time)).then(() => newfn(...nargs))
        }

        // Test
        static testTask() {
            const t = new task();
            t.addTask(300, function () { console.log(arguments) }, 1, 2, 'task-1');
            t.addTask(0, function () { console.log(arguments) }, 2, { "task-id": '2' }, 'task-2');
            t.addTask(200, function () { console.log(arguments) }, 3, 2, 'task-3');
            t.addTask(100, function () { console.log(arguments) }, 4, 2, 'task-4');
            t.addTask(1000, 'task-5');
        }
    }
    exports.task = task;
});