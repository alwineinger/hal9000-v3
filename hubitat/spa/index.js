/**
 * spa/index.js
 * Barrel export for the refactored spa scheduling modules.
 */

module.exports = {
  config: require('./config'),
  weather: require('./weather'),
  preheat: require('./preheat'),
  session: require('./session'),
  approval: require('./approval'),
  telegram: require('./telegram'),
  scheduler: require('./scheduler'),
};
