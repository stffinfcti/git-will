"use strict";

const { analyze, normalizeAuthor, estimateRepoBusFactor } = require("./analyze");
const { draftWill } = require("./will");

module.exports = { analyze, normalizeAuthor, estimateRepoBusFactor, draftWill };
