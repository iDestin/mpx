import { isObject, noop, remove } from '../helper/utils'
import { error, warn } from '../helper/log'
import ReactiveEffect from './effect'
import { isRef } from './ref'
import { isReactive } from './reactive'
import { queueWatcher, queuePreFlushCb, queuePostFlushCb } from './scheduler'
import { callWithErrorHandling } from '../helper/errorHandling'
import { currentInstance } from '../core/proxy'

export function watchEffect (effect, options) {
  return doWatch(effect, null, options)
}

export function watchPostEffect (effect, options) {
  return doWatch(effect, null, { ...options, flush: 'post' })
}

export function watchSyncEffect (effect, options) {
  doWatch(effect, null, { ...options, flush: 'sync' })
}

const warnInvalidSource = (s) => {
  warn(`Invalid watch source: ${s}\nA watch source can only be a getter/effect function, a ref, a reactive object, or an array of these types.`)
}

const shouldTrigger = (value, oldValue) => !Object.is(value, oldValue) || isObject(value)

function doWatch (source, cb, { immediate, deep, flush }) {
  const instance = currentInstance
  let getter
  let isMultiSource = false
  if (isRef(source)) {
    getter = () => source.value
  } else if (isReactive(source)) {
    getter = () => source
    deep = true
  } else if (isArray(source)) {
    isMultiSource = true
    getter = () =>
      source.map(s => {
        if (isRef(s)) {
          return s.value
        } else if (isReactive(s)) {
          return traverse(s)
        } else if (isFunction(s)) {
          return callWithErrorHandling(s, instance, 'watch getter')
        } else {
          warnInvalidSource(s)
        }
      })
  } else if (isFunction(source)) {
    if (cb) {
      // getter with cb
      getter = () =>
        callWithErrorHandling(source, instance, 'watch getter')
    } else {
      // no cb -> simple effect
      getter = () => {
        if (instance && instance.isDestroyed()) {
          return
        }
        if (cleanup) {
          cleanup()
        }
        return callWithErrorHandling(source, instance, 'watch callback', [onCleanup])
      }
    }
  } else {
    getter = noop
    warnInvalidSource(source)
  }

  if (cb && deep) {
    const baseGetter = getter
    getter = () => traverse(baseGetter())
  }

  let cleanup
  let onCleanup = (fn) => {
    cleanup = effect.onStop = () => {
      callWithErrorHandling(fn, instance, 'watch cleanup')
    }
  }

  let oldValue = isMultiSource ? [] : undefined
  const job = () => {
    if (!effect.active) return
    if (cb) {
      const newValue = effect.run()
      if (
        deep ||
        (isMultiSource
          ? newValue.some((v, i) => shouldTrigger(v, oldValue[i]))
          : shouldTrigger(newValue, oldValue))
      ) {
        // cleanup before running cb again
        if (cleanup) {
          cleanup()
        }
        callWithErrorHandling(cb, instance, 'watch callback', [newValue, oldValue, onCleanup])
        oldValue = newValue
      }
    } else {
      // watchEffect
      effect.run()
    }
  }

  job.allowRecurse = !!cb

  let scheduler
  if (flush === 'sync') {
    // the scheduler function gets called directly
    scheduler = job
  } else if (flush === 'post') {
    scheduler = () => queuePostFlushCb(job)
  } else {
    // default: 'pre'
    scheduler = () => {
      if (!instance || instance.isMounted()) {
        queuePreFlushCb(job)
      } else {
        // with 'pre' option, the first call must happen before
        // the component is mounted so it is called synchronously.
        job()
      }
    }
  }

  const effect = new ReactiveEffect(getter, scheduler)

  if (cb) {
    if (immediate) {
      job()
    } else {
      oldValue = effect.run()
    }
  } else if (flush === 'post') {
    queuePostFlushCb(effect.run.bind(effect))
  } else {
    effect.run()
  }

  return () => {
    effect.stop()
    if (instance && instance.scope) {
      remove(instance.scope.effects, effect)
    }
  }
}


export function watch (vm, expOrFn, cb, options) {
  if (isObject(cb)) {
    options = cb
    cb = cb.handler
  }
  if (typeof cb === 'string') {
    if (vm.target && vm.target[cb]) {
      cb = vm.target[cb]
    } else {
      cb = noop
    }
  }

  cb = cb || noop

  options = options || {}
  options.user = true

  if (options.once) {
    const _cb = cb
    const onceCb = typeof options.once === 'function'
      ? options.once
      : function () {
        return true
      }
    cb = function (...args) {
      const res = onceCb.apply(this, args)
      if (res) watcher.teardown()
      _cb.apply(this, args)
    }
  }

  const watcher = new Watcher(vm, expOrFn, cb, options)
  if (!vm._namedWatchers) vm._namedWatchers = {}
  const name = options.name
  if (name) {
    if (vm._namedWatchers[name]) error(`已存在name=${name} 的 watcher，当存在多个 name 相同 watcher 时仅保留当次创建的 watcher，如需都保留请使用不同的 name！`)
    vm._namedWatchers[name] = watcher
  }
  if (options.immediate) {
    cb.call(vm.target, watcher.value)
  } else if (options.immediateAsync) {
    watcher.immediateAsync = true
    queueWatcher(watcher)
  }

  return function unwatchFn () {
    watcher.teardown()
  }
}
