figma.showUI(__html__, { width: 340, height: 260, title: 'Design System Token Sync' });

const FONT_WEIGHT_MAP = {
  'Thin': 100, 'ExtraLight': 200, 'Light': 300, 'Regular': 400,
  'Medium': 500, 'SemiBold': 600, 'Semi Bold': 600, 'Bold': 700,
  'ExtraBold': 800, 'Extra Bold': 800, 'Black': 900,
};

// Reverse map: weight number → fontStyle string (for import)
const WEIGHT_TO_STYLE = {};
for (var _k in FONT_WEIGHT_MAP) WEIGHT_TO_STYLE[FONT_WEIGHT_MAP[_k]] = _k;

function serializePaint(p) {
  var out = { type: p.type, visible: p.visible !== false };
  if (p.type === 'SOLID') {
    out.color = { r: p.color.r, g: p.color.g, b: p.color.b };
    out.opacity = (p.opacity !== undefined) ? p.opacity : 1;
  }
  return out;
}

function serializeEffect(e) {
  var out = { type: e.type, visible: e.visible !== false };
  if (e.color) out.color = { r: e.color.r, g: e.color.g, b: e.color.b, a: e.color.a };
  if (e.offset) out.offset = { x: e.offset.x, y: e.offset.y };
  if (e.radius !== undefined) out.radius = e.radius;
  if (e.spread !== undefined) out.spread = e.spread;
  return out;
}

// Parse "#RRGGBB" or "rgba(r,g,b,a)" → Figma { r, g, b, a } (0–1 floats)
function parseFigmaColor(str) {
  var hex = /^#([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(str);
  if (hex) {
    return { r: parseInt(hex[1], 16) / 255, g: parseInt(hex[2], 16) / 255, b: parseInt(hex[3], 16) / 255, a: 1 };
  }
  var rgba = /^rgba\((\d+),(\d+),(\d+),([\d.]+)\)$/.exec(str.replace(/\s/g, ''));
  if (rgba) {
    return { r: parseInt(rgba[1]) / 255, g: parseInt(rgba[2]) / 255, b: parseInt(rgba[3]) / 255, a: parseFloat(rgba[4]) };
  }
  return null;
}

// ── Export ────────────────────────────────────────────────────────────────────

async function handleExport() {
  const [collections, variables] = await Promise.all([
    figma.variables.getLocalVariableCollectionsAsync(),
    figma.variables.getLocalVariablesAsync(),
  ]);
  const textStyles   = figma.getLocalTextStyles();
  const paintStyles  = figma.getLocalPaintStyles();
  const effectStyles = figma.getLocalEffectStyles();
  const gridStyles   = figma.getLocalGridStyles();

  if (collections.length === 0) {
    figma.ui.postMessage({ type: 'error', message: 'No local variables found in this file.' });
    return;
  }

  const meta = {
    variableCollections: {},
    variables: {},
    styles: {
      text: textStyles.map(function(s) {
        return {
          id: s.id, name: s.name,
          fontFamily: s.fontName.family, fontStyle: s.fontName.style,
          fontWeight: (FONT_WEIGHT_MAP[s.fontName.style] !== undefined) ? FONT_WEIGHT_MAP[s.fontName.style] : 400,
          fontSize: s.fontSize, lineHeight: s.lineHeight, letterSpacing: s.letterSpacing,
          paragraphSpacing: s.paragraphSpacing, textDecoration: s.textDecoration,
          textCase: s.textCase, description: s.description || '',
        };
      }),
      paint: paintStyles.map(function(s) {
        return { id: s.id, name: s.name, description: s.description || '', paints: s.paints.map(serializePaint) };
      }),
      effect: effectStyles.map(function(s) {
        return { id: s.id, name: s.name, description: s.description || '', effects: s.effects.map(serializeEffect) };
      }),
      grid: gridStyles.map(function(s) {
        return {
          id: s.id, name: s.name, description: s.description || '',
          layoutGrids: s.layoutGrids.map(function(g) {
            return { pattern: g.pattern, sectionSize: g.sectionSize, count: g.count,
                     gutterSize: g.gutterSize, offset: g.offset, alignment: g.alignment, visible: g.visible !== false };
          }),
        };
      }),
    },
  };

  for (const c of collections) {
    meta.variableCollections[c.id] = { id: c.id, name: c.name, modes: c.modes, variableIds: c.variableIds };
  }
  for (const v of variables) {
    meta.variables[v.id] = { id: v.id, name: v.name, resolvedType: v.resolvedType,
                              variableCollectionId: v.variableCollectionId, valuesByMode: v.valuesByMode };
  }

  figma.ui.postMessage({ type: 'download', data: { schemaVersion: 2, exportedAt: new Date().toISOString(), fileKey: figma.fileKey, meta } });
}

// ── Import ────────────────────────────────────────────────────────────────────

async function handleImport(data) {
  const results = { variables: 0, textStyles: 0, paintStyles: 0, effectStyles: 0, gridStyles: 0, errors: [] };

  // ── Variables ──────────────────────────────────────────────────────────────
  if (data.variables && Object.keys(data.variables).length) {
    const [collections, allVars] = await Promise.all([
      figma.variables.getLocalVariableCollectionsAsync(),
      figma.variables.getLocalVariablesAsync(),
    ]);

    for (var colName in data.variables) {
      var colData = data.variables[colName];
      var col = null;
      for (var i = 0; i < collections.length; i++) {
        if (collections[i].name === colName) { col = collections[i]; break; }
      }
      if (!col) { results.errors.push('Collection not found: ' + colName); continue; }

      // Resolve target mode (by name, fallback to first)
      var mode = col.modes[0];
      if (colData.mode) {
        for (var j = 0; j < col.modes.length; j++) {
          if (col.modes[j].name === colData.mode) { mode = col.modes[j]; break; }
        }
      }

      for (var varName in colData.values) {
        var localValue = colData.values[varName];
        try {
          // Find existing variable by name in this collection
          var variable = null;
          for (var k = 0; k < allVars.length; k++) {
            if (allVars[k].name === varName && allVars[k].variableCollectionId === col.id) {
              variable = allVars[k]; break;
            }
          }

          // Determine Figma value type from local value
          var figmaValue;
          if (typeof localValue === 'number') {
            figmaValue = localValue;
            if (!variable) variable = figma.variables.createVariable(varName, col, 'FLOAT');
          } else if (typeof localValue === 'string') {
            figmaValue = parseFigmaColor(localValue);
            if (!figmaValue) { results.errors.push('Unparseable color: ' + varName); continue; }
            if (!variable) variable = figma.variables.createVariable(varName, col, 'COLOR');
          } else {
            continue;
          }

          variable.setValueForMode(mode.modeId, figmaValue);
          results.variables++;
        } catch (e) {
          results.errors.push(varName + ': ' + e.message);
        }
      }
    }
  }

  // ── Text styles ────────────────────────────────────────────────────────────
  if (data.styles && data.styles.text && Object.keys(data.styles.text).length) {
    var existingText = figma.getLocalTextStyles();
    for (var tName in data.styles.text) {
      var td = data.styles.text[tName];
      try {
        var ts = null;
        for (var ti = 0; ti < existingText.length; ti++) {
          if (existingText[ti].name === tName) { ts = existingText[ti]; break; }
        }
        if (!ts) { ts = figma.createTextStyle(); ts.name = tName; }

        if (td.fontFamily) ts.fontName = { family: td.fontFamily, style: WEIGHT_TO_STYLE[td.fontWeight] || 'Regular' };
        if (td.fontSize   !== undefined) ts.fontSize     = td.fontSize;
        if (td.lineHeight)               ts.lineHeight   = td.lineHeight;
        if (td.letterSpacing)            ts.letterSpacing = td.letterSpacing;
        if (td.paragraphSpacing !== undefined) ts.paragraphSpacing = td.paragraphSpacing;
        if (td.textDecoration)           ts.textDecoration = td.textDecoration;
        if (td.textCase)                 ts.textCase       = td.textCase;
        if (td.description !== undefined) ts.description  = td.description;
        results.textStyles++;
      } catch (e) {
        results.errors.push(tName + ': ' + e.message);
      }
    }
  }

  // ── Paint styles ───────────────────────────────────────────────────────────
  if (data.styles && data.styles.paint && Object.keys(data.styles.paint).length) {
    var existingPaint = figma.getLocalPaintStyles();
    for (var pName in data.styles.paint) {
      var pd = data.styles.paint[pName];
      try {
        var ps = null;
        for (var pi = 0; pi < existingPaint.length; pi++) {
          if (existingPaint[pi].name === pName) { ps = existingPaint[pi]; break; }
        }
        if (!ps) { ps = figma.createPaintStyle(); ps.name = pName; }

        // pd may be a single {type,value} object or an array
        var entries = Array.isArray(pd) ? pd : [pd];
        ps.paints = entries.filter(function(e) { return e.type === 'SOLID'; }).map(function(e) {
          var col = parseFigmaColor(e.value);
          return col ? { type: 'SOLID', color: { r: col.r, g: col.g, b: col.b }, opacity: col.a } : null;
        }).filter(Boolean);

        results.paintStyles++;
      } catch (e) {
        results.errors.push(pName + ': ' + e.message);
      }
    }
  }

  // ── Effect styles ──────────────────────────────────────────────────────────
  if (data.styles && data.styles.effect && Object.keys(data.styles.effect).length) {
    var existingEffect = figma.getLocalEffectStyles();
    for (var eName in data.styles.effect) {
      var ed = data.styles.effect[eName];
      try {
        var es = null;
        for (var ei = 0; ei < existingEffect.length; ei++) {
          if (existingEffect[ei].name === eName) { es = existingEffect[ei]; break; }
        }
        if (!es) { es = figma.createEffectStyle(); es.name = eName; }

        var edArr = Array.isArray(ed) ? ed : [ed];
        es.effects = edArr.filter(function(e) {
          return e.type === 'DROP_SHADOW' || e.type === 'INNER_SHADOW' || e.type === 'LAYER_BLUR' || e.type === 'BACKGROUND_BLUR';
        }).map(function(e) {
          var effect = { type: e.type, visible: true, blendMode: 'NORMAL' };
          if (e.color) {
            var ec = parseFigmaColor(e.color);
            effect.color = ec || { r: 0, g: 0, b: 0, a: 0.25 };
          }
          if (e.offset) effect.offset = e.offset;
          if (e.radius  !== undefined) effect.radius = e.radius;
          if (e.spread  !== undefined) effect.spread = e.spread;
          return effect;
        });

        results.effectStyles++;
      } catch (e) {
        results.errors.push(eName + ': ' + e.message);
      }
    }
  }

  // ── Grid styles ────────────────────────────────────────────────────────────
  if (data.styles && data.styles.grid && Object.keys(data.styles.grid).length) {
    var existingGrid = figma.getLocalGridStyles();
    for (var gName in data.styles.grid) {
      var gd = data.styles.grid[gName];
      try {
        var gs = null;
        for (var gi = 0; gi < existingGrid.length; gi++) {
          if (existingGrid[gi].name === gName) { gs = existingGrid[gi]; break; }
        }
        if (!gs) { gs = figma.createGridStyle(); gs.name = gName; }

        var gdArr = Array.isArray(gd) ? gd : [gd];
        gs.layoutGrids = gdArr.map(function(g) {
          return { pattern: g.pattern, sectionSize: g.sectionSize, count: g.count,
                   gutterSize: g.gutterSize, offset: g.offset, alignment: g.alignment, visible: true };
        });

        results.gridStyles++;
      } catch (e) {
        results.errors.push(gName + ': ' + e.message);
      }
    }
  }

  figma.ui.postMessage({ type: 'import-result', results: results });
}

// ── Message router ────────────────────────────────────────────────────────────

figma.ui.onmessage = async function(msg) {
  try {
    if (msg.type === 'export') await handleExport();
    else if (msg.type === 'import') await handleImport(msg.data);
  } catch (err) {
    figma.ui.postMessage({ type: 'error', message: err.message });
  }
};
