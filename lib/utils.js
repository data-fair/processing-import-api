// Get the value of an object by a "path" string
// obj: a javascript object like { a: { b: { c: 1 } } }
// path: a string like "a.b.c"
exports.getValueByPath = function (obj, path) {
  if (!path) return obj
  const keys = path.split('.')
  const processed = []
  for (const key of keys) {
    processed.push(key)
    if (key.includes('[]')) {
      const k = key.split('[]')[0]
      if (Object.prototype.hasOwnProperty.call(obj, k) && obj[k] != null) {
        return obj[k].map(o => exports.getValueByPath(o, path.replace(processed.join('.') + '.', ''))).filter(o => o != null)
      }
    } else if (Object.prototype.hasOwnProperty.call(obj, key) && obj[key] != null) {
      obj = obj[key]
    } else {
      return null
    }
  }
  if (obj.constructor === Object) return Object.values(obj)
  else return obj
}
