'use strict';
const { configured, send } = require('./_lib.js');

module.exports = async function handler(req, res) {
  send(res, 200, { configured: configured() });
};
