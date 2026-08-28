"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var fonts = require("../extension/js/features/windows-fonts");

test("Windows font registry parser returns stable unique family names", function () {
  var output = [
    "HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts",
    "    Microsoft YaHei & Microsoft YaHei UI (TrueType)    REG_SZ    msyh.ttc",
    "    Source Han Sans CN Regular (TrueType)    REG_SZ    SourceHanSansCN-Regular.otf",
    "    Source Han Sans CN Regular (TrueType)    REG_SZ    duplicate.otf"
  ].join("\r\n");
  assert.deepEqual(fonts.parseRegistryOutput(output).map(function (font) { return font.familyName; }), [
    "Microsoft YaHei & Microsoft YaHei UI",
    "Source Han Sans CN"
  ]);
});
