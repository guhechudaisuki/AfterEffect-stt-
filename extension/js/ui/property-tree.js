"use strict";

function PropertyTree(container, options) {
  this.container = container;
  this.options = options || {};
  this.selection = {};
  this.seenModules = {};
}

PropertyTree.prototype.clear = function (message) {
  this.container.innerHTML = "";
  var paragraph = document.createElement("p");
  paragraph.className = "empty-row";
  paragraph.textContent = message || "没有可显示的属性";
  this.container.appendChild(paragraph);
  this.selection = {};
  this.seenModules = {};
};

PropertyTree.prototype.render = function (root) {
  this.container.innerHTML = "";
  this.selection = {};
  this.seenModules = {};
  if (!root) return this.clear();
  var fragment = document.createDocumentFragment();
  var children = root.children && root.children.length ? root.children : [root];
  for (var i = 0; i < children.length; i += 1) fragment.appendChild(this.renderNode(children[i], null));
  this.container.appendChild(fragment);
};

PropertyTree.prototype.renderNode = function (node, parentModuleId) {
  var self = this;
  var hasChildren = node.children && node.children.length;
  var wrapper = hasChildren ? document.createElement("details") : document.createElement("div");
  if (!hasChildren) wrapper.className = "property-leaf";
  var row = hasChildren ? document.createElement("summary") : wrapper;
  var moduleId = node.moduleId || node.ownerModuleId;
  var isModuleRoot = moduleId && moduleId !== parentModuleId && !this.seenModules[moduleId];
  if (isModuleRoot) this.seenModules[moduleId] = true;
  var checkboxSlot = document.createElement("span");
  if (isModuleRoot) {
    var checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = true;
    checkbox.dataset.moduleId = moduleId;
    checkbox.addEventListener("change", function () { self.selection[moduleId] = checkbox.checked; if (self.options.onChange) self.options.onChange(self.getSelection()); });
    checkboxSlot.appendChild(checkbox);
    this.selection[moduleId] = true;
  }
  var name = document.createElement("span");
  name.className = "property-name";
  name.textContent = node.name || node.matchName || "Property";
  name.title = node.matchName || node.name || "";
  var meta = document.createElement("span");
  meta.className = "property-meta";
  meta.textContent = node.keys && node.keys.length ? node.keys.length + " keys" : "";
  if (hasChildren) {
    row.appendChild(checkboxSlot);
    row.appendChild(name);
    row.appendChild(meta);
    wrapper.appendChild(row);
    var childWrap = document.createElement("div");
    childWrap.className = "property-children";
    for (var i = 0; i < node.children.length; i += 1) childWrap.appendChild(this.renderNode(node.children[i], moduleId || parentModuleId));
    wrapper.appendChild(childWrap);
  } else {
    var spacer = document.createElement("span");
    row.appendChild(spacer);
    row.appendChild(checkboxSlot);
    row.appendChild(name);
    row.appendChild(meta);
  }
  return wrapper;
};

PropertyTree.prototype.getSelection = function () {
  var output = {};
  Object.keys(this.selection).forEach(function (key) { output[key] = this.selection[key]; }, this);
  return output;
};

PropertyTree.prototype.selectedModuleIds = function () {
  var self = this;
  return Object.keys(this.selection).filter(function (key) { return self.selection[key] !== false; });
};

module.exports = PropertyTree;
