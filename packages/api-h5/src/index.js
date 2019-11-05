import * as allApi from './api/apis'

export default function install (target) {
  Object.keys(allApi).forEach(api => {
    target[api] = function (...args) {
      return allApi[api].apply(this, args)
    }
  })
}
