#!/usr/bin/env node
"use strict";

/**
 * G-code Post-Processor — v1.4
 *
 * Updates:
 * - v1.1: Enhanced summary log
 * - v1.2: Removed optional chaining for CommonJS compatibility
 * - v1.3: Fixed function naming, removed any remaining optional chaining, and corrected entry point.
 * - v1.4: Added coordinate tracking and fast-move tagging
 */

const fs = require('fs').promises;
const path = require('path');

const files = [];
const toolDict = new Map();
const defFiles = [];

const logPath = path.resolve(process.cwd(), 'gcode-post.log');
let log;

const DEFAULT_FEED_RATE = 500;
const params = {
  fr: undefined,
  filterTags: [],
  filtered: false,
};

/**
 * Track and compute absolute XYZ coordinates for each line
 */
class CommandProcessor {
  constructor() {
    this.x = 0;
    this.y = 0;
    this.z = 5; // Because G0 Z5 is hard coded at the beginning of each file

    this.currentCommand = '';

    this.min = { x: this.x, y: this.y, z: this.z};
    this.max = { x: this.x, y: this.y, z: this.z};
  }
  /**
   * Parses a G-code line, updates internal XYZ, and returns start/end coords
   */
  processLine(ln) {
    const start = { x: this.x, y: this.y, z: this.z };

    if (/^(?:G0|G1)\b/.test(ln.raw)) {
      this.currentCommand = String(ln.raw).substring(0, 2);
    }
    

    // parse axis tokens
    const tokens = ln.raw.trim().split(/\s+/);
    let newX = this.x;
    let newY = this.y;
    let newZ = this.z;
    for (let t of tokens) {
      if (/^[XYZ]/i.test(t)) {
        const axis = t[0].toUpperCase();
        const val = parseFloat(t.slice(1));
        if (!isNaN(val)) {
          if (axis === 'X') newX = val;
          if (axis === 'Y') newY = val;
          if (axis === 'Z') newZ = val;
        }
      }
    }
    
    this.x = newX;
    this.y = newY;
    this.z = newZ;

    // Track min/max
    this.min.x = Math.min(this.min.x, this.x);
    this.max.x = Math.max(this.max.x, this.x);
    this.min.y = Math.min(this.min.y, this.y);
    this.max.y = Math.max(this.max.y, this.y);
    this.min.z = Math.min(this.min.z, this.z);
    this.max.z = Math.max(this.max.z, this.z);

    const end = { x: this.x, y: this.y, z: this.z };
    return [start, end];
  }
}

/**
 * Represents a single parsed line of G-code.
 */
class Line {
  constructor(raw) {
    this.raw = raw;
    this.ignored = this._calcIgnored();
    this.isFirst = false;
    this.isComment = this._calcComment();;
    this.startCoord = { x: 0, y: 0, z: 0 };
    this.endCoord = { x: 0, y: 0, z: 0 };
    this.isFastMove = false;
    this.fastMoveReason = '';

    this.hasX = /[X]/i.test(this.raw);
    this.hasY = /[Y]/i.test(this.raw);
    this.hasZ = /[Z]/i.test(this.raw);
    this.hasXY = this.hasX || this.hasY;
    this.hasMotion = /^(?:G0|G1)\b|[XYZ]/i.test(this.raw);

    this.tags = {};
  }
  clone(raw) {
    const newLine = new Line(raw);
    Object.assign(newLine.startCoord, this.startCoord);
    Object.assign(newLine.endCoord, this.endCoord);
    return newLine;
  }
  matchTags(tags) {
    return tags.every(tag => Object.hasOwn(this.tags, tag));
  }
  _calcIgnored() {
    const tokens = this.raw.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return false;
    const pattern = /^(?:G90|G94|G17|G21|G54|M|T|S)/i;
    return tokens.every(function(t) { return pattern.test(t); });
  }
  _calcComment() {
    return this.raw.startsWith('(');
  }
}

/**
 * Representation of a single NC file and its metadata.
 */
class FileObject {
  constructor(filePath, lines) {
    this.path = filePath;
    this.lines = lines;
    this.name = this._extractName(lines);
    this.tool = this._extractTool(lines);
    this.setup = this._extractSetup(lines);
    this.zo = this._extractZO(lines);
    this.operation = this._extractOperation(filePath) || 0;
    this.isDrilling = this._extractIsDrilling(lines);
    this.allowFastMoves = this._calcAllowFastMoves();
  }

  _extractName(lines) {
    var firstLine = '';
    if (lines && lines.length > 0 && lines[0].raw) {
      firstLine = lines[0].raw;
    }
    return firstLine.replace(/^\s*\(/, '').replace(/\)\s*$/, '').trim();
  }

  _extractTool(lines) {
    for (let ln of lines) {
      const m = ln.raw.match(/^\s*T(\d+)/i);
      if (m) {
        return 'T' + m[1];
      }
    }
    return 'T?';
  }
  
  _extractSetup(lines) {
    for (let ln of lines) {
      const commentMatch = ln.raw.match(/^\s*\((.*)\)\s*$/);
      if (commentMatch) {
        const setupMatch = commentMatch[1].match(/(?:^|\s)SETUP=([^\s)]+)/i);
        if (setupMatch) return setupMatch[1];
      }
    }
    return null;
  }

  _extractZO(lines) {
    for (let ln of lines) {
      const commentMatch = ln.raw.match(/^\s*\((.*)\)\s*$/);
      if (commentMatch) {
        const zoMatch = commentMatch[1].match(/(?:^|\s)ZO=([^\s)]+)/i);
        if (zoMatch) return parseFloat(zoMatch[1]);
      }
    }
    return null;
  }

  _extractOperation(filePath) {
    const regex = /\bop\s*(\d+)/i;
    const match = filePath.match(regex);
    if (!match) return null;
    return parseInt(match[1], 10);
  }

  lineCount() {
    return this.lines.length;
  }

  _extractIsDrilling(lines) {
    for (let ln of lines) {
      // look for a full-line comment whose text starts with "Drill"
      const commentMatch = ln.raw.match(/^\s*\((.*)\)\s*$/);
      if (commentMatch) {
        // commentMatch[1] is the text inside the parens
        if (/^Drill/i.test(commentMatch[1])) {
          return true;
        }
      }
    }
    return false;
  }

  _calcAllowFastMoves() {
    return !this.isDrilling;
  }
}

function parseArgs() {
  try {
    const args = process.argv.slice(2); // skip node and script name
    let i = 0;
    while (i < args.length) {
      if (args[i] === '-fr' || args[i] === '--feedRate') {
        if (args.length<i+2) {
          console.log(' Feed rate parameter missing');
        }
        params.fr = parseFloat(args[i + 1]);
        console.log(' Feed rate: ' + params.fr);
        i += 2;
      } 
      else if ('--filter') {
        if (args.length<i+2) {
          console.log(' Filter parameter missing.  Usage: --filter "FAST XY"');
        }
        params.filtered = true;
        params.filterTags = args[i + 1].split(/\s+/); // array of tag words
        i += 2;
      }
      else if (args.includes('-h') || args.includes('--help')) {
        console.log('Usage: gcode-post [-fr --feedRate [500]]');
        process.exit(0);
      } else {
        // Handle unknown options or other flags as needed
        i++;
      }
    }
  } catch(ex) {
    console.error(ex.message);
  }
  
}


async function main() {
  try {
    parseArgs();

    log = await fs.open(logPath, 'w');
    await log.write('BEGIN\n');

    // 1) build the tool dictionary
    await buildToolDict();

    // 2) find, load, and merge files
    const ncPaths = await findNcFiles();
    await loadFiles(ncPaths);
    await mergeBySetupAndTool(files);

    await log.write('\nDONE');
    console.log('Processed ' + files.length + ' file(s). See gcode-post.log.');
  } catch (err) {
    await log.write(err.message);
    console.error('Post-processor failed:', err);
    process.exitCode = 1;
  } finally {
    await log.close();
  }
}

/**
 * Scan all .nc files for tool definitions and populate global toolDict.
 */
async function buildToolDict() {
  await log.write('Parsing tool definition files...\n');
  toolDict.clear();
  defFiles.length = 0;
  const ncPaths = await findNcFiles();
  for (let p of ncPaths) {
    const text = await fs.readFile(p, 'utf8');
    const lines = text.split(/\r?\n/);
    for (let ln of lines) {
      const m = ln.match(/^\s*\(\s*T(\d+)\s+D=([\d.]+)/i);
      if (m) {
        const toolKey = 'T' + m[1];
        const dia = parseFloat(m[2]);
        if (!toolDict.has(toolKey)) {
          toolDict.set(toolKey, {
            diameter: dia,
            definitionFilename: p
          });
        }
        defFiles.push(p);
        break;
      }
    }
  }
  await log.write('OK\n');
}

/**
 * Locate all *.nc files in CWD, sorted by modified time ascending.
 */
async function findNcFiles() {
  const cwd = process.cwd();
  const entries = await fs.readdir(cwd, { withFileTypes: true });

  const filePaths = entries
    .filter(ent => ent.isFile() && ent.name.toLowerCase().endsWith('.nc'))
    .map(ent => path.resolve(cwd, ent.name));

  const filesWithTime = await Promise.all(filePaths.map(async file => {
    const stats = await fs.stat(file);
    return { file, mtime: stats.mtime };
  }));

  filesWithTime.sort((a, b) => a.mtime - b.mtime);
  return filesWithTime.map(entry => entry.file);
}

/**
 * Parse .nc files into FileObject instances, skipping any definition files.
 */
async function loadFiles(paths) {
  await log.write('Loading files...\n');
  files.length = 0;
  
  for (let filePath of paths) {
    if (defFiles.includes(filePath)) continue;

    await log.write('\t' + filePath + '\n');
    const content = await fs.readFile(filePath, 'utf8');
    const rawLines = content.split(/\r?\n/);
    const lineObjs = rawLines.map(txt => new Line(txt));

    // flag the first G0/G1
    for (let ln of lineObjs) {
      if (/^\s*(G0|G1)\b/i.test(ln.raw)) {
        ln.isFirst = true;
        break;
      }
    }

    // track coords and flag fast-move candidates

    const fo = new FileObject(filePath, lineObjs);
    
    if (fo.allowFastMoves) {
      fo.commandProcessor = new CommandProcessor();
      for (let ln of fo.lines) {
        const [start, end] = fo.commandProcessor.processLine(ln);
        ln.startCoord = start;
        ln.endCoord = end;

        // Determine axis motion
        const hasX = ln.hasX;
        const hasY = ln.hasY;
        const hasZ = ln.hasZ;
        const anyXY = hasX || hasY;

        // 1. XY (or XYZ) moves at safe height (Z >= 0 throughout): FAST
        if (anyXY && start.z >= 0 && end.z >= 0) {
          ln.isFastMove = true;
          ln.fastMoveReason = `anyXY{${anyXY}} && start.z{${start.z}} >= 0 && end.z{${end.z}} >= 0`;

        // 2. Z-only upward moves (retracts to safe height): FAST
        } else if (!anyXY && hasZ && (end.z > start.z) && end.z >= 0) {
          ln.isFastMove = true;

        // 3. Otherwise: NOT FAST
        } else {
          ln.isFastMove = false;
        }
      }
    }

    files.push(fo);
  }
}

//
// Merge Helpers
//

function sortByOperation(files) {
  return files.slice().sort((a, b) => (a.operation || 0) - (b.operation || 0));
}

function assignSetupNumbers(files) {
  const map = new Map();
  let counter = 1;
  for (const f of files) {
    const name = f.setup || 'unknown';
    if (!map.has(name)) {
      map.set(name, { name, number: counter++ });
    }
  }
  return map;
}

function groupBySetupAndTool(files) {
  const map = new Map();
  for (const f of files) {
    const setupName = f.setup || 'unknown';
    const key = `${setupName}||${f.tool}`;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(f);
  }
  return map;
}

async function createSetupFolder(setupObj) {
  const folderName = `Setup ${setupObj.number} - ${setupObj.name}`;
  const outDir = path.resolve(process.cwd(), folderName);
  await fs.mkdir(outDir, { recursive: true });
  return outDir;
}

function generateFilename(opIndex, group, toolDict) {
  const tool      = group[0].tool;
  const entry     = toolDict.get(tool);
  const diameter  = entry?.diameter != null ? entry.diameter.toFixed(2) : 'unknown';
  const fileCount = group.length;
  const op        = `Op ${opIndex}`;
  return `${op.padEnd(5)} - ${diameter}mm ${tool.padEnd(3)} - ${String(fileCount).padStart(2)} file(s).nc`;
}

function aggregateStats(files) {
  // Initialize with extreme values
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

  for (const f of files) {
    const stats = f.commandProcessor;
    if (!stats) continue;
    minX = Math.min(minX, stats.min.x);
    minY = Math.min(minY, stats.min.y);
    minZ = Math.min(minZ, stats.min.z);
    maxX = Math.max(maxX, stats.max.x);
    maxY = Math.max(maxY, stats.max.y);
    maxZ = Math.max(maxZ, stats.max.z);
  }
  return {
    min: {
      x: minX.toFixed(3).padStart(8),
      y: minY.toFixed(3).padStart(8),
      z: minZ.toFixed(3).padStart(8),
    },
    max: {
      x: maxX.toFixed(3).padStart(8),
      y: maxY.toFixed(3).padStart(8),
      z: maxZ.toFixed(3).padStart(8),
    }
  };
}

function processFeedRate(line) {
  if (typeof params.fr === 'undefined') return line;
  // Replace all F-something with F<feedRate> (preserving G-code case)
  return line.replace(/\bF\d+(\.\d+)?\b/gi, `F${params.fr}`);
}


function parseTags(ln) {
  const tags = ln.tags;

  // FAST
  if (ln.isFastMove) {
    tags['FAST'] = true;
  }

  // Axis tags
  const hasX = ln.hasX;
  const hasY = ln.hasY;
  const hasZ = ln.hasZ;
  const axes = [hasX ? 'X' : '', hasY ? 'Y' : '', hasZ ? 'Z' : ''].join('');
  tags[axes] = true;

  // UNENGAGED: Z always >= 0 for both start and end
  if (ln.startCoord.z >= 0 && ln.endCoord.z >= 0) {
    tags['UNENGAGED'] = true;
  }

  // Add more tags as needed
}

function addTagsToLines(group) {
  const output = [];
  for (const fItem of group) {
    let lastWasFast = false;  // track if previous line was a FAST MOVE
    for (const ln of fItem.lines) {
      if (!ln.ignored && !ln.isComment) {
        if (ln.raw.trim().length === 0) {
          continue;
        }
        parseTags(ln);
        if (fItem.allowFastMoves) {
          if (ln.isFastMove) {
            lastWasFast = true;
          } else {
            if (lastWasFast) {
              // Duplicate last raw FAST line, switch G0 to G1 to reset modal
              const resetLine =  ln.clone('G1');
              resetLine.tags['RESET-FR'] = true;
              output.push(resetLine);
              lastWasFast = false;
            }
          }
        }
        output.push(ln);
      }
    }
    fItem.lines = output;
  }
}

function buildContentLines(group) {
  const contentLines = [];
  const startLines   = new Map();

  contentLines.push('', `G90 G94 G17 G21 G54 F${params.fr || DEFAULT_FEED_RATE}`, '');

  const groupStats = aggregateStats(group);
  contentLines.push(
    '; AGGREGATE STATS - ALL FILES',
    `(${' '.padEnd(46)}MIN: ${' '.padEnd(26)}${groupStats.min.x} ${groupStats.min.y} ${groupStats.min.z})`,
    `(${' '.padEnd(46)}MAX: ${' '.padEnd(26)}${groupStats.max.x} ${groupStats.max.y} ${groupStats.max.z})`,
    ''
  );

  let fileCnt = 0;
  for (const fItem of group) {
    startLines.set(fItem.path, contentLines.length + 1);
    contentLines.push('G0 Z5\n\n');

    // print all comment lines
    let commentCnt = 0;
    for (const ln of fItem.lines) {
      if (ln.isComment) {
        commentCnt++;  
        contentLines.push(ln.raw);
      }
    }
    if(commentCnt>0) {
      contentLines.push('\n');
    }

    // Print File stats
    const stats = fItem.commandProcessor;
    if (stats) {
      const min = {
        x: stats.min.x.toFixed(3).padStart(8),
        y: stats.min.y.toFixed(3).padStart(8),
        z: stats.min.z.toFixed(3).padStart(8)
      };
      const max = {
        x: stats.max.x.toFixed(3).padStart(8),
        y: stats.max.y.toFixed(3).padStart(8),
        z: stats.max.z.toFixed(3).padStart(8)
      };
      contentLines.push(
        `; FILE ${++fileCnt} STATS`,
        `(${' '.padEnd(46)}MIN: ${' '.padEnd(26)}${min.x} ${min.y} ${min.z})`,
        `(${' '.padEnd(46)}MAX: ${' '.padEnd(26)}${max.x} ${max.y} ${max.z})`,
        ''
      );
    }

    const padding = 50;

    for (const ln of fItem.lines) {
      if (!ln.ignored && !ln.isComment) {

        if (ln.raw.trim().length === 0) {
          contentLines.push('');  
          continue;
        }

        const lineTags = Object.keys(ln.tags);

        if (params.filtered && !ln.matchTags(params.filterTags)) {
          continue;
        }

        const s = ln.startCoord;
        const e = ln.endCoord;
        const c1 = [s.x, s.y, s.z].map(v => v.toFixed(3).padStart(8)).join(' ');
        const c2 = [e.x, e.y, e.z].map(v => v.toFixed(3).padStart(8)).join(' ');
        let coords = c1 + '\t' + c2;
        
        let raw = processFeedRate(ln.raw);
        
        if (fItem.allowFastMoves) {
          if (ln.isFastMove) {
            // FAST MOVE lines use G0
            let rawFast = raw.replace(/^\s*(G1\b)/i, 'G0');
            if (!/^\s*(G0\b)/i.test(rawFast)) rawFast = rawFast.replace(/^\s*/, 'G0 ');
            contentLines.push(rawFast.padEnd(padding) + '; ' + coords + ' # ' + lineTags.join(' '));
          } else {
            // output the actual non-fast line unmodified
            contentLines.push(raw.padEnd(padding) + '; ' + coords + ' # ' + lineTags.join(' '));
          }
        } else {
          contentLines.push(raw.padEnd(padding + '; ' + coords + ' # ' + lineTags.join(' ')));
        }
      }
    }

    for (let i = 0; i < 10; i++) {
      contentLines.push('');
    }
  }

  contentLines.push('G0 Z5', 'G0 X0 Y0');
  return { contentLines, startLines };
}

async function writeFile(filePath, lines) {
  const payload = lines.map(l => l.endsWith('\n') ? l : l + '\n').join('');
  await fs.writeFile(filePath, payload);
}

async function mergeBySetupAndTool(fileList) {
  const ordered = sortByOperation(fileList);
  const setups  = assignSetupNumbers(ordered);
  const groups  = groupBySetupAndTool(ordered);

  let opIndex = 1;
  for (const [key, group] of groups) {
    const [setupName] = key.split('||');
    const setupObj    = setups.get(setupName);
    const outDir      = await createSetupFolder(setupObj);
    const filename    = generateFilename(opIndex++, group, toolDict);
    const outPath     = path.resolve(outDir, filename);

    addTagsToLines(group);

    const { contentLines, startLines } = buildContentLines(group);

    const headerLines = ['(MERGED)', ''];
    const headerLen   = headerLines.length + group.length;
    for (const fItem of group) {
      const fname = path.basename(fItem.path);
      const start = headerLen + startLines.get(fItem.path);
      headerLines.push(`(${String(start).padStart(5)} - ${fname})`);
    }

    const merged = [...headerLines, ...contentLines];
    await writeFile(outPath, merged);
  }
}

if (require.main === module) {
  main();
}
