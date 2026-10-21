const ASSET_MODE = globalThis.EC_PLATE_ASSET_MODE || "mirror";
const MIRROR_BASE = globalThis.EC_PLATE_MIRROR_BASE || globalThis.EC_PLATE_ASSET_BASE || "./mirror";
const REPO_BRANCH = globalThis.EC_PLATE_REPO_BRANCH || "main";
let mirrorManifestPromise = null;
const bundleCache = new Map();

const I18N_BASE_PATH = "./cipulot_ec-plate-maker_files/i18n";
const DEFAULT_LANGUAGE = "en";

async function loadI18n() {
  const manifestRes = await fetch(`${I18N_BASE_PATH}/manifest.json`);
  if (!manifestRes.ok) {
    throw new Error(`i18n manifest fetch failed: HTTP ${manifestRes.status}`);
  }
  const manifest = await manifestRes.json();

  const localeResults = await Promise.allSettled(
    manifest.languages.map(({ code }) =>
      fetch(`${I18N_BASE_PATH}/${code}.json`).then((r) => {
        if (!r.ok) throw new Error(`${code}.json: HTTP ${r.status}`);
        return r.json().then((data) => ({ code, data }));
      }),
    ),
  );

  const loaded = [];
  for (const result of localeResults) {
    if (result.status === "fulfilled") {
      loaded.push(result.value);
    } else {
      console.warn("[i18n] Failed to load locale:", result.reason);
    }
  }

  if (loaded.length === 0) {
    throw new Error("i18n: no locales loaded");
  }

  for (const { code, name } of manifest.languages) {
    languageNames[code] = name;
  }

  // ORDER MATTERS for dynamicTranslations: longer phrases must precede shorter
  // substrings of themselves (e.g. "EC60X & EC60X SE - Tray Mount" before
  // "Tray Mount"). The JSON file preserves insertion order.
  for (const { code, data } of loaded) {
    uiText[code] = data.ui;

    for (const [optionKey, valueMap] of Object.entries(data.options || {})) {
      const optionArray = commonOptions[optionKey];
      if (!optionArray) {
        console.warn(`[i18n] Unknown option group in ${code}.json: ${optionKey}`);
        continue;
      }
      for (const optionEntry of optionArray) {
        if (Object.prototype.hasOwnProperty.call(valueMap, optionEntry.value)) {
          optionEntry[code] = valueMap[optionEntry.value];
        }
      }
    }

    for (const [englishKey, localized] of Object.entries(data.fieldLabels || {})) {
      fieldLabelMap[englishKey] = fieldLabelMap[englishKey] || {};
      fieldLabelMap[englishKey][code] = localized;
    }

    for (const [englishKey, localized] of Object.entries(data.groupLabels || {})) {
      groupLabelMap[englishKey] = groupLabelMap[englishKey] || {};
      groupLabelMap[englishKey][code] = localized;
    }

    dynamicReplacements[code] = data.dynamicTranslations || [];
  }

  const loadedCodes = loaded.map((l) => l.code);
  SUPPORTED_LANGUAGES.length = 0;
  for (const { code } of manifest.languages) {
    if (loadedCodes.includes(code)) SUPPORTED_LANGUAGES.push(code);
  }

  return { manifest, loadedCodes };
}

function populateLanguageSelect(manifest, loadedCodes) {
  if (!els.languageSelect) return;
  els.languageSelect.innerHTML = "";
  for (const { code, name } of manifest.languages) {
    if (!loadedCodes.includes(code)) continue;
    const option = document.createElement("option");
    option.value = code;
    option.textContent = name;
    els.languageSelect.appendChild(option);
  }
}

function showI18nLoadError(error) {
  console.error("[i18n] Initialization failed:", error);
  const main = document.querySelector(".app-shell");
  if (main) {
    main.innerHTML =
      '<div style="padding: 2rem; text-align: center;">' +
      "<h2>Failed to load translations</h2>" +
      "<p>The page could not load its language data. Please reload the page. " +
      "If the problem persists, check the browser console for details.</p>" +
      "</div>";
  }
}

const commonOptions = {
  capsLock: [
    { value: "0" },
    { value: "1" },
  ],
  backspace: [
    { value: "0" },
    { value: "1" },
  ],
  leftShift: [
    { value: "0" },
    { value: "1" },
  ],
  rightShift60: [
    { value: "0" },
    { value: "1" },
    { value: "2" },
  ],
  rightShiftAlice: [
    { value: "0" },
    { value: "1" },
  ],
  enter: [
    { value: "0" },
    { value: "1" },
  ],
  switchType: [
    { value: "General_OEM_Style" },
    { value: "Dynacap_Style" },
  ],
};

const languageNames = {};

const uiText = {};

const fieldLabelMap = {};

const groupLabelMap = {};

const LANGUAGE_STORAGE_KEY = "ec-plate-language";
const SUPPORTED_LANGUAGES = [];

function loadLanguage() {
  const savedLanguage = window.localStorage.getItem(LANGUAGE_STORAGE_KEY);
  return SUPPORTED_LANGUAGES.includes(savedLanguage) ? savedLanguage : "en";
}

function setLanguage(language) {
  state.language = SUPPORTED_LANGUAGES.includes(language) ? language : "en";
  window.localStorage.setItem(LANGUAGE_STORAGE_KEY, state.language);
}

function t(key, variables = {}) {
  const text = uiText[state.language]?.[key] ?? uiText.en?.[key] ?? key;
  return Object.entries(variables).reduce(
    (result, [variable, value]) => result.replaceAll(`{${variable}}`, value),
    text,
  );
}

function getLocalizedText(entry, fallback = "") {
  if (!entry) {
    return fallback;
  }

  // If exact locale key exists, use it
  if (entry[state.language]) return entry[state.language];

  // For non-English locales: auto-translate from English when localized value is missing
  if (state.language !== "en" && entry.en) {
    return translateEnglishText(entry.en, state.language);
  }

  // English is the sole fallback
  return entry.en ?? fallback;
}

const dynamicReplacements = {};

function translateEnglishText(text, language) {
  const pairs = dynamicReplacements[language] || [];
  return pairs.reduce(
    (currentText, [from, to]) => currentText.replaceAll(from, to),
    text,
  );
}

function getFieldLabel(field) {
  const fallback = { en: field.en, "zh-CN": field.en, ja: field.en, ko: field.en };
  return getLocalizedText(fieldLabelMap[field.en] || fallback, field.en);
}

function getGroupLabel(group) {
  const mapped = groupLabelMap[group.original];
  if (mapped) return getLocalizedText(Object.assign({ en: group.original }, mapped), group.original);

  const title = group.title;
  let entry;
  if (title && typeof title === "object") {
    entry = Object.assign({ en: group.original }, title);
    entry["zh-CN"] = entry["zh-CN"] ?? group.original;
    entry.ja = entry.ja ?? group.original;
    entry.ko = entry.ko ?? group.original;
  } else {
    entry = { en: group.original, "zh-CN": group.original, ja: group.original, ko: group.original };
  }

  return getLocalizedText(entry, group.original);
}

const plateConfigs = [
  {
    id: "ec60x-se",
    title: "60% EC PCB",
    repo: "ec60x-plate-maker",
    defaultValues: {
      board: "EC60X",
      enter: "0",
      bottom_row: "0",
      caps_lock: "0",
      backspace: "0",
      left_shift: "0",
      right_shift: "0",
      switch_type: "General_OEM_Style",
    },
    filenameFields: ["caps_lock", "backspace", "left_shift", "right_shift", "enter", "bottom_row"],
    groups: [
      { title: { en: "Base Board" }, original: "Base Board", fields: ["board"] },
      { title: { en: "Enter" }, original: "Enter", fields: ["enter"] },
      { title: { en: "Bottom Row" }, original: "Bottom Row", fields: ["bottom_row"] },
      { title: { en: "Split Keys" }, original: "Split Keys", fields: ["caps_lock", "backspace", "left_shift", "right_shift"] },
      { title: { en: "Switch Type" }, original: "Switch Type", fields: ["switch_type"] },
    ],
    fields: {
      board: {
        en: "Base Board",
        layout: "wide",
        options: [
          { value: "Brutal60", en: "Brutal60" },
          { value: "Clap_CH1", en: "Clap CH1" },
          { value: "Dalco_959", en: "Dalco 959" },
          { value: "EC60X", en: "EC60X & EC60X SE" },
          { value: "EC60X_Tray_Mount", en: "EC60X & EC60X SE - Tray Mount" },
          { value: "ECRX", en: "ECRX" },
          { value: "Frog_Mini", en: "Frog Mini" },
          { value: "H2H", en: "H2H" },
          { value: "Hiya", en: "Hiya" },
          { value: "IRON160", en: "IRON160" },
          { value: "J-02", en: "J-02" },
          { value: "Larva", en: "Larva" },
          { value: "LX_Keebs_6060", en: "LX Keebs 6060" },
          { value: "Magic3_60", en: "Magic3 60" },
          { value: "Mao_HHKB", en: "Mao HHKB" },
          { value: "Pangea_Mini", en: "Pangea Mini" },
          { value: "Polaris", en: "Polaris" },
          { value: "Pro2K", en: "Pro2K" },
          { value: "Ramune60", en: "Ramune60" },
          { value: "Rin60", en: "Rin60" },
          { value: "Rule60V3", en: "Rule60 V3" },
          { value: "Saturn_60", en: "Saturn 60" },
          { value: "Sho_HG", en: "Sho HG" },
          { value: "Sho_S60v3", en: "Sho S60v3" },
          { value: "Thermal", en: "Thermal" },
          { value: "Tofu60_2_0", en: "Tofu60 2.0" },
          { value: "Tofu60_3_0", en: "Tofu60 3.0" },
          { value: "Tycan", en: "Tycan" },
          { value: "TYP60", en: "TYP60" },
          { value: "Type_B", en: "Type-B" },
          { value: "Vero_V2", en: "Vero V2" },
        ],
      },
      enter: { en: "Enter", layout: "dense", options: commonOptions.enter },
      bottom_row: {
        en: "Bottom Row",
        layout: "wide",
        options: [
          { value: "0", en: "7U WK" },
          { value: "1", en: "7U WKL" },
          { value: "2", en: "7U HHKB" },
          { value: "3", en: "6.25U" },
          { value: "4", en: "Split 6.25U" },
          { value: "5", en: "6U" },
          { value: "6", en: "6U 2-Way Split (2U Housing)" },
          { value: "7", en: "6U 2-Way Split (3U Stabs)" },
          { value: "8", en: "6U 3-Way Split" },
          { value: "9", en: "6U HHKB" },
          { value: "10", en: "6U HHKB 2-Way Split (2U Housing)" },
          { value: "11", en: "6U HHKB 2-Way Split (3U Stabs)" },
          { value: "12", en: "6U HHKB 3-Way Split" },
          { value: "13", en: "JIS WK" },
          { value: "14", en: "JIS WKL" },
          { value: "15", en: "7U (6U Stab)" },
          { value: "16", en: "7U WKL (6U Stab)" },
          { value: "17", en: "7U HHKB (6U Stab)" },
        ],
      },
      caps_lock: { en: "Caps Lock", layout: "dense", options: commonOptions.capsLock },
      backspace: { en: "Backspace", layout: "dense", options: commonOptions.backspace },
      left_shift: { en: "Left Shift", layout: "dense", options: commonOptions.leftShift },
      right_shift: { en: "Right Shift", layout: "dense", options: commonOptions.rightShift60 },
      switch_type: { en: "Switch Type", layout: "dense", options: commonOptions.switchType },
    },
  },
  {
    id: "ec65x",
    title: "65% EC PCB",
    repo: "ec65x-plate-maker",
    defaultValues: {
      board: "EC65X",
      enter: "0",
      bottom_row: "0",
      caps_lock: "0",
      backspace: "0",
      left_shift: "0",
      switch_type: "General_OEM_Style",
    },
    filenameFields: ["caps_lock", "backspace", "left_shift", "enter", "bottom_row"],
    groups: [
      { title: { en: "Base Board" }, original: "Base Board", fields: ["board"] },
      { title: { en: "Enter" }, original: "Enter", fields: ["enter"] },
      { title: { en: "Bottom Row" }, original: "Bottom Row", fields: ["bottom_row"] },
      { title: { en: "Split Keys" }, original: "Split Keys", fields: ["caps_lock", "backspace", "left_shift"] },
      { title: { en: "Switch Type" }, original: "Switch Type", fields: ["switch_type"] },
    ],
    fields: {
      board: {
        en: "Base Board",
        layout: "wide",
        options: [
          { value: "Bauer_Lite", en: "Bauer Lite" },
          { value: "Eave65", en: "Eave65" },
          { value: "EC65X", en: "EC65X" },
          { value: "IRON165", en: "IRON165" },
          { value: "Phi65", en: "Phi65" },
          { value: "SixtyFive_Mode", en: "SixtyFive Mode" },
          { value: "TGR_910", en: "TGR 910 (REQUIRES EC65X Rev 1.3 or higher OR Dyna65)" },
        ],
      },
      enter: { en: "Enter", layout: "dense", options: commonOptions.enter },
      bottom_row: {
        en: "Bottom Row",
        layout: "dense",
        options: [
          { value: "0", en: "7U" },
          { value: "1", en: "6.25U" },
          { value: "2", en: "Split 6.25U" },
          { value: "3", en: "Bauer" },
        ],
      },
      caps_lock: { en: "Caps Lock", layout: "dense", options: commonOptions.capsLock },
      backspace: { en: "Backspace", layout: "dense", options: commonOptions.backspace },
      left_shift: { en: "Left Shift", layout: "dense", options: commonOptions.leftShift },
      switch_type: { en: "Switch Type", layout: "dense", options: commonOptions.switchType },
    },
  },
  {
    id: "ec-tkl-x-se",
    title: "TKL EC PCB",
    repo: "ec_tkl_x-plate-maker",
    defaultValues: {
      board: "EC_TKL_X",
      f_row: "0",
      enter: "0",
      bottom_row: "0",
      caps_lock: "0",
      backspace: "0",
      left_shift: "0",
      right_shift: "0",
      switch_type: "General_OEM_Style",
    },
    filenameFields: ["caps_lock", "f_row", "backspace", "left_shift", "right_shift", "enter", "bottom_row"],
    groups: [
      { title: { en: "Base Board" }, original: "Base Board", fields: ["board"] },
      { title: { en: "F-Row / Enter" }, original: "F-Row / Enter", fields: ["f_row", "enter"] },
      { title: { en: "Bottom Row" }, original: "Bottom Row", fields: ["bottom_row"] },
      { title: { en: "Split Keys" }, original: "Split Keys", fields: ["caps_lock", "backspace", "left_shift", "right_shift"] },
      { title: { en: "Switch Type" }, original: "Switch Type", fields: ["switch_type"] },
    ],
    fields: {
      board: {
        en: "Base Board",
        layout: "wide",
        options: [
          { value: "Bias_DE", en: "Bias DE" },
          { value: "Bias_R2", en: "Bias R2" },
          { value: "Caerdroia", en: "Caerdroia" },
          { value: "CLASSIC_TKL", en: "CLASSIC TKL" },
          { value: "EC_TKL_X", en: "EC TKL X & EC TKL X SE" },
          { value: "F1-8X", en: "F1-8X" },
          { value: "Jane_V3", en: "Jane V3 (F13 only!)" },
          { value: "Transition", en: "Transition" },
        ],
      },
      f_row: {
        en: "F-Row",
        layout: "dense",
        options: [
          { value: "0", en: "F13" },
          { value: "1", en: "F12" },
        ],
      },
      enter: { en: "Enter", layout: "dense", options: commonOptions.enter },
      bottom_row: {
        en: "Bottom Row",
        layout: "wide",
        options: [
          { value: "0", en: "7U WK" },
          { value: "1", en: "7U WKL" },
          { value: "2", en: "7U HHKB" },
          { value: "3", en: "6.25U" },
          { value: "4", en: "Split 6.25U" },
          { value: "5", en: "6U" },
          { value: "6", en: "6U 2-Way Split (2U Housing)" },
          { value: "7", en: "6U 2-Way Split (3U Stabs)" },
          { value: "8", en: "6U 3-Way Split" },
          { value: "9", en: "6U HHKB" },
          { value: "10", en: "6U HHKB 2-Way Split (2U Housing)" },
          { value: "11", en: "6U HHKB 2-Way Split (3U Stabs)" },
          { value: "12", en: "6U HHKB 3-Way Split" },
          { value: "13", en: "JIS WK" },
          { value: "14", en: "JIS WKL" },
        ],
      },
      caps_lock: { en: "Caps Lock", layout: "dense", options: commonOptions.capsLock },
      backspace: { en: "Backspace", layout: "dense", options: commonOptions.backspace },
      left_shift: { en: "Left Shift", layout: "dense", options: commonOptions.leftShift },
      right_shift: { en: "Right Shift", layout: "dense", options: commonOptions.rightShift60 },
      switch_type: { en: "Switch Type", layout: "dense", options: commonOptions.switchType },
    },
  },
  {
    id: "ec-alice-x",
    title: "Alice EC PCB",
    repo: "ec_alice-plate-maker",
    defaultValues: {
      board: "TGR_Alice_OSAv2",
      left_spacebar: "0",
      caps_lock: "0",
      backspace: "0",
      right_shift: "0",
      switch_type: "General_OEM_Style",
    },
    filenameFields: ["caps_lock", "backspace", "right_shift", "left_spacebar"],
    groups: [
      { title: { en: "Base Board" }, original: "Base Board", fields: ["board"] },
      { title: { en: "Left Spacebar" }, original: "Left Spacebar", fields: ["left_spacebar"] },
      { title: { en: "Split Keys" }, original: "Split Keys", fields: ["caps_lock", "backspace", "right_shift"] },
      { title: { en: "Switch Type" }, original: "Switch Type", fields: ["switch_type"] },
    ],
    fields: {
      board: {
        en: "Base Board",
        layout: "wide",
        options: [
          { value: "Dolice", en: "Dolice (NOTE: must use the EC Alice X PCB)" },
          { value: "Iron_Alice", en: "Iron Alice" },
          { value: "Nasu", en: "Nasu" },
          { value: "TGR_Alice_OSAv2", en: "TGR Alice & OSAv2 & Praxis IM" },
          { value: "Tengu", en: "Tengu" },
        ],
      },
      left_spacebar: {
        en: "Left Spacebar",
        layout: "dense",
        options: [
          { value: "0", en: "Left Spacebar 2U" },
          { value: "1", en: "Left Spacebar 2.25U" },
        ],
      },
      caps_lock: { en: "Caps Lock", layout: "dense", options: commonOptions.capsLock },
      backspace: { en: "Backspace", layout: "dense", options: commonOptions.backspace },
      right_shift: { en: "Right Shift", layout: "dense", options: commonOptions.rightShiftAlice },
      switch_type: { en: "Switch Type", layout: "dense", options: commonOptions.switchType },
    },
  },
];

// Display mapping for PCB list (primary category + multiline subtitle)
const pcbDisplayMap = {
  "ec60x-se": {
    main: "60%",
    sub: [
      "EC60X (Rev ≥1.2)",
      "EC60X SE (Rev ≥1.0)",
      "DC60 (Rev ≥1.0)",
    ],
  },
  ec65x: {
    main: "65%",
    sub: ["EC65X (Rev ≥1.0)", "DC65 (Rev ≥1.0)"],
  },
  "ec-tkl-x-se": {
    main: "TKL",
    sub: ["EC TKL X (Rev ≥1.0)", "EC TKL X SE (Rev ≥1.0)"],
  },
  "ec-alice-x": {
    main: "Alice",
    sub: ["EC Alice (Rev ≥1.0)", "EC Alice X (Rev ≥1.0)"],
  },
};

const state = {
  activeId: null,
  language: DEFAULT_LANGUAGE,
  valuesByConfig: Object.fromEntries(plateConfigs.map((config) => [config.id, createEmptyValues(config)])),
};

const els = {
  pageTitle: document.querySelector("#pageTitle"),
  languageLabel: document.querySelector("#languageLabel"),
  languageSelect: document.querySelector("#languageSelect"),
  sourceStatus: document.querySelector("#sourceStatus"),
  pcbList: document.querySelector("#pcbList"),
  pcbTitle: document.querySelector("#pcbTitle"),
  activeTitle: document.querySelector("#activeTitle"),
  configForm: document.querySelector("#configForm"),
  resetButton: document.querySelector("#resetButton"),
  downloadTitle: document.querySelector("#downloadTitle"),
  dxfLabel: document.querySelector("#dxfLabel"),
  zipLabel: document.querySelector("#zipLabel"),
  dxfName: document.querySelector("#dxfName"),
  zipName: document.querySelector("#zipName"),
  downloadButton: document.querySelector("#downloadButton"),
  copyButton: document.querySelector("#copyButton"),
  downloadMessage: document.querySelector("#downloadMessage"),
  sourceLinks: document.querySelector("#sourceLinks"),
  footerCopyright: document.querySelector("#footerCopyright"),
  footerLicense: document.querySelector("#footerLicense"),
};

function syncShellCopy() {
  document.documentElement.lang = state.language;
  document.title = t("pageTitle");

  if (els.pageTitle) els.pageTitle.textContent = t("pageTitle");
  if (els.languageLabel) els.languageLabel.textContent = t("language");
  if (els.languageSelect) els.languageSelect.value = state.language;
  if (els.sourceStatus) els.sourceStatus.textContent = t("sourceStatus");
  if (els.pcbTitle) els.pcbTitle.textContent = t("selectPcb");
  if (els.downloadTitle) els.downloadTitle.textContent = t("download");
  if (els.dxfLabel) els.dxfLabel.textContent = t("dxfFile");
  if (els.zipLabel) els.zipLabel.textContent = t("zipFile");
  if (els.resetButton) els.resetButton.textContent = t("clearSelection");
  if (els.downloadButton) els.downloadButton.textContent = t("generateZip");
  if (els.copyButton) els.copyButton.textContent = t("copyFilename");
  if (els.footerCopyright) {
    els.footerCopyright.textContent = t("footerCopyright");
  }
  if (els.footerLicense) {
    els.footerLicense.textContent = t("footerLicenseLabel");
    els.footerLicense.href = t("footerLicenseUrl");
  }
}

function getActiveConfig() {
  return plateConfigs.find((config) => config.id === state.activeId);
}

function getValues(config = getActiveConfig()) {
  return config ? state.valuesByConfig[config.id] : {};
}

function createEmptyValues(config) {
  return Object.fromEntries(Object.keys(config.fields).map((fieldId) => [fieldId, ""]));
}

function getRequiredFields(config) {
  return Object.keys(config.fields);
}

function getMissingFields(config, values) {
  return getRequiredFields(config).filter((fieldId) => !values[fieldId]);
}

function isConfigComplete(config, values) {
  return Boolean(config) && getMissingFields(config, values).length === 0;
}

function getSwitchSuffix(values) {
  return values.switch_type === "Dynacap_Style" ? "_Dynacap" : "";
}

function buildDxfName(config, values) {
  const indices = config.filenameFields.map((fieldId) => values[fieldId]).join("_");
  return `${values.board}_${indices}${getSwitchSuffix(values)}.dxf`;
}

function buildDxfSourcePath(values, dxfName) {
  return `Plate_Indexed_Name/${values.board}_Plate_Indexed_Name/${dxfName}`;
}

function buildZipName(config, values) {
  const indices = config.filenameFields.map((fieldId) => values[fieldId]).join("_");
  return `${values.board}_${indices}${getSwitchSuffix(values)}.zip`;
}

function buildRepoFileUrl(config, fileName) {
  return buildSourceUrl(config, fileName);
}

function joinMirrorUrl(path) {
  if (/^https?:\/\//i.test(path)) {
    return path;
  }

  return `${MIRROR_BASE.replace(/\/$/, "")}/${path.replace(/^\//, "")}`;
}

function buildSourceUrl(config, sourcePath) {
  const repoSegment = ASSET_MODE === "github-proxy" ? `${config.repo}/${REPO_BRANCH}` : config.repo;
  return joinMirrorUrl(`${repoSegment}/${sourcePath}`);
}

function renderPcbList() {
  els.pcbList.innerHTML = plateConfigs
    .map(
      (config) => `
        <button class="pcb-button ${config.id === state.activeId ? "is-active" : ""}" type="button" data-config-id="${config.id}">
          ${(() => {
          const display = pcbDisplayMap[config.id] || { main: config.title };
          const subtitle = Array.isArray(display.sub) ? display.sub.join("<br>") : (display.sub ? String(display.sub) : "");
          const subtitleHtml = subtitle ? `<span class="option-pcb-name-list">${subtitle}</span>` : "";
          return `<span class="option-layout">${display.main}</span>${subtitleHtml}`;
        })()}
        </button>
      `,
    )
    .join("");
}

function renderOptionButton(config, fieldId, field, option, values) {
  const isActive = values[fieldId] === option.value;
  const optionText = getLocalizedText(option, option.en);

  return `
    <button
      class="option-button ${isActive ? "is-active" : ""}"
      type="button"
      data-field-id="${fieldId}"
      data-value="${option.value}"
      aria-pressed="${isActive ? "true" : "false"}"
    ><span class="option-layout">${optionText}</span></button>
  `;
}

function renderField(config, fieldId, values, groupLabel) {
  const field = config.fields[fieldId];
  const gridClass = field.layout === "wide"
    ? "option-grid option-grid-wide"
    : field.layout === "dense"
      ? "option-grid option-grid-dense"
      : "option-grid";

  const fieldLabel = getFieldLabel(field);
  const labelHtml = fieldLabel === groupLabel ? "" : `<div class="field-label">${fieldLabel}</div>`;

  return `
    <div class="field-block">
      ${labelHtml}
      <div class="${gridClass}">
        ${field.options.map((option) => renderOptionButton(config, fieldId, field, option, values)).join("")}
      </div>
    </div>
  `;
}

function renderConfigForm() {
  const config = getActiveConfig();

  if (!config) {
    els.activeTitle.textContent = t("selectPcb");
    els.resetButton.disabled = true;
    els.configForm.innerHTML = `
      <div class="empty-state">
        <p class="empty-title">${t("emptyTitle")}</p>
        <p>${t("emptyDescription")}</p>
      </div>
    `;
    return;
  }

  const values = getValues(config);

  els.resetButton.disabled = false;
  els.activeTitle.textContent = config.title;
  els.configForm.innerHTML = config.groups
    .map(
      (group) => `
        <section class="field-group" aria-label="${getGroupLabel(group)}">
          <div class="group-title">
            <h3>${getGroupLabel(group)}</h3>
          </div>
          <div class="field-stack">
            ${group.fields.map((fieldId) => renderField(config, fieldId, values, getGroupLabel(group))).join("")}
          </div>
        </section>
      `,
    )
    .join("");
}

function renderDownloadPanel() {
  const config = getActiveConfig();

  if (!config) {
    els.dxfName.textContent = t("selectPcbFirst");
    els.zipName.textContent = t("selectPcbFirst");
    els.downloadButton.disabled = true;
    els.copyButton.disabled = true;
    els.sourceLinks.innerHTML = `<p class="source-disclaimer">${t("disclaimerShort")}</p>`;
    return;
  }

  const values = getValues(config);
  const missingFields = getMissingFields(config, values);
  const isComplete = missingFields.length === 0;

  els.downloadButton.disabled = !isComplete;
  els.copyButton.disabled = !isComplete;

  if (!isComplete) {
    const selectedCount = getRequiredFields(config).length - missingFields.length;
    const totalCount = getRequiredFields(config).length;
    els.dxfName.textContent = t("incompleteStatus", { selected: selectedCount, total: totalCount });
    els.zipName.textContent = t("completeHint");
    els.sourceLinks.innerHTML = `<p class="source-disclaimer">${t("disclaimerShort")}</p>`;
    return;
  }

  const dxfName = buildDxfName(config, values);
  const zipName = buildZipName(config, values);

  els.dxfName.textContent = dxfName;
  els.zipName.textContent = zipName;
  els.sourceLinks.innerHTML = `<p class="source-disclaimer">${t("disclaimerShort")}</p>`;
}

function render() {
  syncShellCopy();
  renderPcbList();
  renderConfigForm();
  renderDownloadPanel();
}

function setMessage(message, tone = "muted") {
  els.downloadMessage.textContent = message;
  els.downloadMessage.dataset.tone = tone;
}

async function fetchArrayBuffer(url, label) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${label} 获取失败：HTTP ${response.status}`);
  }
  return response.arrayBuffer();
}

async function fetchText(url, label) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${label} 获取失败：HTTP ${response.status}`);
  }
  return response.text();
}

async function getMirrorManifest() {
  if (!mirrorManifestPromise) {
    mirrorManifestPromise = fetch(joinMirrorUrl("manifest.json")).then((response) => {
      if (!response.ok) {
        throw new Error(`Mirror manifest fetch failed: HTTP ${response.status}`);
      }
      return response.json();
    });
  }
  return mirrorManifestPromise;
}

async function getBundleZip(bundlePath) {
  if (!bundleCache.has(bundlePath)) {
    const bundleUrl = joinMirrorUrl(bundlePath);
    const bundlePromise = fetchArrayBuffer(bundleUrl, "定位板镜像包").then((buffer) => JSZip.loadAsync(buffer));
    bundleCache.set(bundlePath, bundlePromise);
  }
  return bundleCache.get(bundlePath);
}

async function fetchDxfFromMirror(config, values, dxfName) {
  if (ASSET_MODE === "github-proxy") {
    return fetchArrayBuffer(buildSourceUrl(config, buildDxfSourcePath(values, dxfName)), t("dxfFile"));
  }

  if (window.location.protocol === "file:") {
    throw new Error("Local mirror mode requires opening the page via http://localhost. Use a local server for preview.");
  }

  const manifest = await getMirrorManifest();
  const record = manifest.files?.[`${config.id}/${dxfName}`];
  if (!record) {
    throw new Error(`本地镜像中没有找到 ${dxfName}，请重新同步镜像文件。`);
  }

  const bundle = await getBundleZip(record.bundle);
  const file = bundle.file(record.file);
  if (!file) {
    throw new Error(`镜像包中没有找到 ${record.file}，请重新同步镜像文件。`);
  }

  return file.async("arraybuffer");
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

async function downloadZip() {
  const config = getActiveConfig();
  const values = getValues(config);

  if (!isConfigComplete(config, values)) {
    setMessage(t("needCompleteZip"), "error");
    return;
  }

  const dxfName = buildDxfName(config, values);
  const zipName = buildZipName(config, values);

  els.downloadButton.disabled = true;
  els.copyButton.disabled = true;
  setMessage(ASSET_MODE === "github-proxy" ? t("fetchProxy") : t("fetchMirror"));

  try {
    const zip = new JSZip();
    const [dxfBuffer, licenseText, specBuffer] = await Promise.all([
      fetchDxfFromMirror(config, values, dxfName),
      fetchText(buildRepoFileUrl(config, "LICENSE"), "LICENSE"),
      fetchArrayBuffer(buildRepoFileUrl(config, "EC_Plate_Specifications.pdf"), "EC_Plate_Specifications.pdf"),
    ]);

    zip.file(dxfName, dxfBuffer);
    zip.file("LICENSE", licenseText);
    zip.file("EC_Plate_Specifications.pdf", specBuffer);

    if (config.repo === "ec60x-plate-maker" && values.board === "EC60X_Tray_Mount") {
      const extras = [
        ["special_countersunk.png", "special_countersunk.png"],
        ["tray_mount_countersinking.pdf", "tray_mount_countersinking.pdf"],
      ];
      const extraBuffers = await Promise.all(
        extras.map(([fileName]) => fetchArrayBuffer(buildRepoFileUrl(config, fileName), fileName)),
      );
      extras.forEach(([, zipFileName], index) => zip.file(zipFileName, extraBuffers[index]));
    }

    setMessage(t("generatingZip"));
    const blob = await zip.generateAsync({ type: "blob" });
    downloadBlob(blob, zipName);
    setMessage(t("generated", { name: zipName }), "success");
  } catch (error) {
    setMessage(error.message || t("downloadFailed"), "error");
  } finally {
    renderDownloadPanel();
  }
}

async function copyFileName() {
  const config = getActiveConfig();
  const values = getValues(config);

  if (!isConfigComplete(config, values)) {
    setMessage(t("needCompleteCopy"), "error");
    return;
  }

  const dxfName = buildDxfName(config, values);

  try {
    await navigator.clipboard.writeText(dxfName);
    setMessage(t("copied", { name: dxfName }), "success");
  } catch {
    setMessage(t("copyBlocked"), "error");
  }
}

els.languageSelect.addEventListener("change", (event) => {
  setLanguage(event.target.value);
  setMessage("");
  render();
});

els.pcbList.addEventListener("click", (event) => {
  const button = event.target.closest("[data-config-id]");
  if (!button) return;

  state.activeId = button.dataset.configId;
  setMessage("");
  render();
});

els.configForm.addEventListener("click", (event) => {
  const button = event.target.closest("[data-field-id]");
  if (!button) return;

  const config = getActiveConfig();
  const values = getValues(config);
  values[button.dataset.fieldId] = button.dataset.value;
  setMessage("");
  renderConfigForm();
  renderDownloadPanel();
});

els.resetButton.addEventListener("click", () => {
  const config = getActiveConfig();
  if (!config) return;

  state.valuesByConfig[config.id] = createEmptyValues(config);
  setMessage("");
  renderConfigForm();
  renderDownloadPanel();
});

function showLicenseConfirmation(onAgree) {
  if (document.getElementById("license-confirm-modal")) return;

  const url = t("footerLicenseUrl");

  const overlay = document.createElement("div");
  overlay.id = "license-confirm-modal";
  overlay.className = "modal-overlay";

  const dialog = document.createElement("div");
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.className = "modal-dialog";

  const title = document.createElement("h2");
  title.textContent = t("licenseTitle");
  title.className = "modal-title";

  // link title for aria
  const dialogId = "license-confirm-dialog";
  const titleId = "license-confirm-title";
  dialog.id = dialogId;
  title.id = titleId;
  dialog.setAttribute("aria-labelledby", titleId);

  const message = document.createElement("p");
  message.className = "modal-message";
  const messageTemplate = t("licenseMessage");
  const linkStart = `<a href="${url}" target="_blank" rel="noopener noreferrer">`;
  const linkEnd = "</a>";
  message.innerHTML = messageTemplate
    .replaceAll("{linkStart}", linkStart)
    .replaceAll("{linkEnd}", linkEnd);

  const actions = document.createElement("div");
  actions.className = "modal-actions";

  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.className = "ghost-button modal-cancel";
  cancelBtn.textContent = t("licenseCancel");

  const agreeBtn = document.createElement("button");
  agreeBtn.type = "button";
  agreeBtn.className = "primary-button modal-agree";
  agreeBtn.textContent = t("licenseAgree");

  actions.appendChild(cancelBtn);
  actions.appendChild(agreeBtn);
  dialog.appendChild(title);
  dialog.appendChild(message);
  dialog.appendChild(actions);
  overlay.appendChild(dialog);
  document.body.appendChild(overlay);

  // Focus management and keyboard handling
  const previouslyFocused = document.activeElement;

  // Collect focusable elements inside the dialog
  function getFocusable(container) {
    return Array.from(
      container.querySelectorAll(
        'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])',
      ),
    ).filter((el) => el.offsetWidth > 0 || el.offsetHeight > 0 || el.getClientRects().length);
  }

  function remove() {
    document.removeEventListener("keydown", handleKeyDown, true);
    if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    try {
      if (previouslyFocused && previouslyFocused.focus) previouslyFocused.focus();
    } catch (e) {
      // ignore
    }
  }

  function handleKeyDown(e) {
    if (e.key === "Escape") {
      e.preventDefault();
      remove();
      return;
    }

    if (e.key === "Tab") {
      const focusable = getFocusable(dialog);
      if (focusable.length === 0) {
        e.preventDefault();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey) {
        if (document.activeElement === first) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }
  }

  document.addEventListener("keydown", handleKeyDown, true);

  // Close on overlay click outside dialog
  overlay.addEventListener("click", (ev) => {
    if (ev.target === overlay) remove();
  });

  cancelBtn.addEventListener("click", () => {
    remove();
  });

  agreeBtn.addEventListener("click", () => {
    remove();
    try {
      onAgree();
    } catch (e) {
      console.error(e);
    }
  });

  // Focus the first focusable element (agree button) after mount
  setTimeout(() => {
    const focusable = getFocusable(dialog);
    (focusable[0] || agreeBtn).focus();
  }, 0);
}

function confirmBeforeDownload() {
  const config = getActiveConfig();
  const values = getValues(config);

  if (!isConfigComplete(config, values)) {
    setMessage(t("needCompleteZip"), "error");
    return;
  }

  showLicenseConfirmation(() => downloadZip());
}

els.downloadButton.addEventListener("click", confirmBeforeDownload);
els.copyButton.addEventListener("click", copyFileName);

loadI18n()
  .then(({ manifest, loadedCodes }) => {
    populateLanguageSelect(manifest, loadedCodes);
    state.language = loadLanguage();
    render();
  })
  .catch(showI18nLoadError);
