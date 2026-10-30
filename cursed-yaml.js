"use strict";

const CURSED_UT_REMOVED_OPTIONS = new Set([
  "plando_items",
  "local_items",
  "non_local_items",
  "start_hints",
  "start_location_hints",
  "exclude_locations",
  "priority_locations",
  "boss_shuffle",
  "plando_texts"
]);
const CURSED_UT_COMMENT =
  "# This YAML is for UT support only - it removes item specific options and will not\n" +
  "# generate the same as the original yaml if those options were present with values\n";

function cursedYamlHeader(content) {
  const lines = content.replace(/^\uFEFF/, "").split(/\r\n|\n|\r/);
  const header = [];
  for (const line of lines) {
    if (/^\s*(?:#.*)?$/.test(line)) {
      header.push(line);
    } else if (/^(?:---|%YAML\s+[^#]+|%TAG\s+[^#]+)\s*(?:#.*)?$/.test(line)) {
      const commentIndex = line.indexOf("#");
      if (commentIndex >= 0) {
        header.push(line.slice(commentIndex));
      }
    } else {
      break;
    }
  }
  return header.length ? `${header.join("\n")}\n` : "";
}

function cursedJsonString(value) {
  let output = '"';
  let index = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint > 0xffff) {
      output += character;
    } else if (index === 0 || codePoint < 0x20 || codePoint >= 0x7f || randomInt(4) !== 0) {
      output += `\\u${codePoint.toString(16).padStart(4, "0")}`;
    } else {
      output += JSON.stringify(character).slice(1, -1);
    }
    index += 1;
  }
  return `${output}"`;
}

function cursedJson(value, ancestors = new Set()) {
  if (typeof value === "string") {
    return cursedJsonString(value);
  }
  if (value === null || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) {
      throw new Error("A YAML number cannot be represented safely in JSON.");
    }
    return JSON.stringify(value);
  }
  if (!value || typeof value !== "object" ||
      (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype)) {
    throw new Error("This YAML contains a value that cannot be represented in JSON.");
  }
  if (ancestors.has(value)) {
    throw new Error("This YAML contains a circular alias that cannot be represented in JSON.");
  }
  ancestors.add(value);
  const result = Array.isArray(value)
    ? `[${value.map((item) => cursedJson(item, ancestors)).join(",")}]`
    : `{${shuffledCopy(Object.keys(value)).map((key) =>
        `${cursedJsonString(key)}:${cursedJson(value[key], ancestors)}`).join(",")}}`;
  ancestors.delete(value);
  return result;
}

function curseYaml(content) {
  if (!window.jsyaml) {
    throw new Error("The YAML parser could not load. Refresh the page and try again.");
  }
  const parsed = window.jsyaml.load(content);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) ||
      typeof parsed.name !== "string" || !parsed.name.trim() || typeof parsed.game !== "string") {
    throw new Error("Cursed UT exports require a YAML mapping with string name and game fields.");
  }
  const options = parsed[parsed.game];
  if (!Object.hasOwn(parsed, parsed.game) || !options || typeof options !== "object" || Array.isArray(options)) {
    throw new Error("The YAML game options must be a mapping.");
  }
  const filteredOptions = Object.fromEntries(
    Object.entries(options).filter(([key]) => !CURSED_UT_REMOVED_OPTIONS.has(key))
  );
  const filtered = { ...parsed, [parsed.game]: filteredOptions };
  return {
    player: parsed.name,
    content: `${cursedYamlHeader(content)}${CURSED_UT_COMMENT}${cursedJson(filtered)}\n`
  };
}

function cursedExportFiles(entries) {
  const usedNames = new Set();
  return shuffledCopy(entries).map((entry) => {
    let converted;
    try {
      converted = curseYaml(entry.content);
    } catch (error) {
      throw new Error(`Cannot create cursed YAML for ${extractRootScalar(entry.content, "name") || "an entry"}: ${error.message}`);
    }
    const base = converted.player.replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, "_").replace(/[. ]+$/g, "") || "player";
    const safeBase = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(base) ? `_${base}` : base;
    let name = `${safeBase}.yaml`;
    let suffix = 2;
    while (usedNames.has(name.normalize("NFC").toLowerCase())) {
      name = `${safeBase}-${suffix}.yaml`;
      suffix += 1;
    }
    usedNames.add(name.normalize("NFC").toLowerCase());
    return { name, content: converted.content, modifiedAt: SECRET_EXPORT_MODIFIED_AT };
  });
}
