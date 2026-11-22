'use strict';
const { EurekaPlatform } = require('./lib/platform');

module.exports = (api) => {
  api.registerPlatform('homebridge-eureka-e20', 'EurekaE20', EurekaPlatform);
};
