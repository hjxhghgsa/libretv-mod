/**
 * mpv GLSL → WebGL GLSL 转换器（Anime4K 专用）
 *
 * Anime4K 的 mpv shader 语法规整，需要处理的只有这些：
 *
 *  1. `//!HOOK MAIN` / `//!HOOK PREKERNEL`  —— 挂载点
 *  2. `//!BIND <名字>`  —— 声明输入纹理
 *  3. `//!SAVE <名字>` —— 声明输出纹理
 *  4. `//!WHEN <条件>` —— 条件执行
 *  5. `//!WIDTH/HEIGHT` —— 输出尺寸表达式，可能是 `conv2d_last_tf.w 2 *` 这种
 *
 *  函数与变量替换：
 *   `X_texOff(vec2(off))`   → 以 X 为输入、按 texel 偏移采样
 *   `X_tex(pos)`            → 按归一化坐标采样
 *   `X_pos`                 → 当前像素在 X 纹理里的像素坐标
 *   `X_size`                → X 纹理的像素尺寸
 *   `X_pt`                  → X 的像素步长（1/size）
 *   `HOOKED_xxx`            → HOOKED 指向本 pass 的主输入
 *   `X_tex(...)[i]`         → 数组下标取分量（WebGL 需要手动 swizzle）
 *   `vec4 hook()`           → `void main()` + `return X` → `gl_FragColor = X`
 *
 * ★ Depth-to-Space 这个 pass 特殊：它做的是「把 CNN 的深度通道还原成 2 倍像素」，
 *   依赖 `_pos`（像素坐标）、`_size`、`_pt`（像素步长）三个派生量，
 *   且输出是 `MAIN_tex(MAIN_pos) + CNN结果`（相加而非覆盖）。
 */

export interface MpvPass {
  desc: string;
  hook: 'MAIN' | 'PREKERNEL' | string;
  binds: string[];
  save?: string;
  width?: string;
  height?: string;
  components: number;
  when?: string;
  body: string;
}

export interface ParsedShader {
  passes: MpvPass[];
}

/** 按 //!DESC 切分成 pass 块 */
export function parseMpvShader(src: string): ParsedShader {
  const lines = src.split(/\r?\n/);
  const passes: MpvPass[] = [];

  let cur: MpvPass | null = null;
  let bodyLines: string[] = [];

  const flush = () => {
    if (!cur) return;
    cur.body = bodyLines.join('\n');
    passes.push(cur);
    bodyLines = [];
    cur = null;
  };

  for (const line of lines) {
    const m = line.match(/^\/\/!(DESC|HOOK|BIND|SAVE|WIDTH|HEIGHT|COMPONENTS|WHEN)\b(.*)$/);
    if (m) {
      const key = m[1];
      const val = m[2].trim();
      if (key === 'DESC') {
        flush();
        cur = { desc: val, hook: 'MAIN', binds: [], components: 4, body: '' };
      } else if (cur) {
        if (key === 'HOOK') cur.hook = val;
        else if (key === 'BIND') cur.binds.push(val);
        else if (key === 'SAVE') cur.save = val;
        else if (key === 'WIDTH') cur.width = val;
        else if (key === 'HEIGHT') cur.height = val;
        else if (key === 'COMPONENTS') cur.components = parseInt(val, 10) || 4;
        else if (key === 'WHEN') cur.when = val;
      }
      continue;
    }
    if (cur) bodyLines.push(line);
  }
  flush();
  return { passes };
}

/** 收集整个 shader 链里出现过的所有纹理名 */
export function collectBinds(passes: MpvPass[]): string[] {
  const set = new Set<string>();
  for (const p of passes) {
    for (const b of p.binds) set.add(b);
    if (p.save) set.add(p.save);
  }
  return [...set];
}

/**
 * 判断某个 pass 的输出尺寸规则。
 *
 * ★ Anime4K 的实际规则和「名字里带 Upscale 就 ×2」完全无关：
 *   Upscale 链里，**中间的 CNN pass 全部是同尺寸**（`//!WIDTH conv2d_tf.w`，
 *   它们只在通道/深度维度上工作），只有最后的 Depth-to-Space pass
 *   才是真正的 2× 放大（`//!WIDTH conv2d_last_tf.w 2 *`）。
 *   早期按名字判断导致尺寸一路累乘到 30720×17280。
 *
 * 所以必须解析 `//!WIDTH` 表达式本身。
 */
export function outputScale(pass: MpvPass): 'same' | '2x' {
  const w = pass.width || '';
  // 形如 `conv2d_last_tf.w 2 *` → 末尾是「基准 系数 *」
  if (/\*\s*$/.test(w) && !/\bMAIN\b/.test(w)) {
    const m = w.match(/([0-9]+)\s*\*\s*$/);
    if (m && parseInt(m[1], 10) > 1) return '2x';
  }
  // 形如 `MAIN.w 2 *` 同理
  if (/\bMAIN\b/.test(w)) {
    const m = w.match(/([0-9]+)\s*\*\s*$/);
    if (m && parseInt(m[1], 10) > 1) return '2x';
  }
  return 'same';
}

/**
 * 把一个 pass 的 GLSL 主体转成 WebGL 片元着色器。
 *
 * @param pass      解析出的 pass
 * @param allBinds  本 pass 可见的所有纹理名
 */
/**
 * 翻译条件里的尺寸变量。
 *   OUTPUT.w/h → outW/outH  本 pass 的输出尺寸
 *   MAIN.w/h   → inW/inH    本 pass 的主输入尺寸
 *   NATIVE.w/h → natW/natH  原始视频尺寸（渲染目标尺寸）
 */
function translateCondVar(expr: string): string {
  return expr
    .replace(/\bOUTPUT\.w\b/g, 'outW')
    .replace(/\bOUTPUT\.h\b/g, 'outH')
    .replace(/\bMAIN\.w\b/g, 'inW')
    .replace(/\bMAIN\.h\b/g, 'inH')
    .replace(/\bNATIVE\.w\b/g, 'natW')
    .replace(/\bNATIVE\.h\b/g, 'natH');
}

/**
 * 把 main() 内部的 `return X;` 改成 `gl_FragColor = X;`。
 * main() 之外的函数（get_luma 等）保持原样。
 */
function rewriteReturnsInMain(src: string): string {
  const start = src.indexOf('void main()');
  if (start < 0) return src;
  // 找到 main() 的函数体范围（按花括号配平）
  const open = src.indexOf('{', start);
  if (open < 0) return src;
  let depth = 0;
  let end = -1;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }
  if (end < 0) return src;

  const head = src.slice(0, open + 1);
  const bodyPart = src.slice(open + 1, end);
  const tail = src.slice(end);

  const newBody = bodyPart.replace(/\breturn\s+([^;]+);/g, (m, expr: string) => {
    if (/gl_FragColor/.test(expr)) return m;
    return `gl_FragColor = ${expr.trim()};`;
  });
  return head + newBody + tail;
}

export function passToWebGL(pass: MpvPass, allBinds: string[]): string {
  let body = pass.body;
  const bindSet = new Set(allBinds);

  /**
   * 纹理名 → 实际使用的 sampler 名。
   *
   * ★ 关键：SAVE 名也要算作「可见纹理」。
   *   Anime4K 的 Clamp_Highlights 里第一个 pass 是
   *     //!BIND HOOKED
   *     //!BIND STATSMAX
   *     //!SAVE STATSMAX
   *   STATSMAX 既是 BIND 又是 SAVE，但在这个 pass 里
   *   `STATSMAX_texOff(...)` 读的是**上一个 pass 写出的** STATSMAX，
   *   而当前 pass 正在写同名缓冲 —— mpv 靠 SAVE/BIND 同名区分这两者。
   *   WebGL 里 ping-pong 天然区分（读上一张、写下一张），所以同名是安全的。
   *   但 sampler 必须为它生成，否则 `STATSMAX_texOff` 找不到函数。
   *
   * ★ HOOKED 的语义：mpv 里 `BIND HOOKED` 表示「当前 hook 的主输入」。
   *   在 Anime4K 的 Clamp 段，HOOKED 指的就是**上一段链（Upscale）的最终画面**。
   *   它不叫 MAIN，所以不能简单地把 HOOKED 映射到 MAIN。
   *   这里映射到一个特殊名 HOOKED，引擎侧负责把它接到「最近一个画面类 pass 的输出」。
   */
  const resolveName = (name: string): string => {
    if (name === 'HOOKED') return 'HOOKED';
    if (bindSet.has(name)) return name;
    return 'MAIN';
  };

  // ── ① 宏定义里的纹理调用先改写 ──
  // `#define go_0(x_off, y_off) (MAIN_texOff(vec2(x_off, y_off)))`
  // 宏体内的名字在定义处是参数，直接替换成采样函数名即可。
  body = body.replace(
    /#define\s+(\w+)\s*\(\s*([^)]*)\s*\)\s*\(([^)]*)\)/g,
    (_all, macroName: string, macroParams: string, macroBody: string) => {
      const newBody = macroBody
        .replace(/\b([A-Za-z_][A-Za-z0-9_]*)_texOff\s*\(/g,
          (_a, name: string) => `texOff_${resolveName(name)}(`)
        .replace(/\b([A-Za-z_][A-Za-z0-9_]*)_tex\s*\(/g,
          (_a, name: string) => `tex_${resolveName(name)}(`);
      return `#define ${macroName}(${macroParams}) (${newBody})`;
    }
  );

  // ── ② 派生量：X_pos / X_size / X_pt ──
  // 这些是 mpv 自动为每个绑定纹理提供的量。
  //
  // ★ X_pos 的语义：当前采样点在 X 纹理里的**像素坐标**。
  //   实际只用在一处 —— Depth-to-Space 的 `fract(X_pos * X_size)`。
  //   那个式子取的是「当前像素在 2×2 块里的哪个角」，
  //   等价于 fract(vUv)（vUv 是归一化坐标，fract 后同样是块内偏移），
  //   但**块的大小**取决于该纹理相对输出的缩放比。
  //   这里用 vUv * size_X 还原像素坐标，语义与 mpv 一致。
  body = body.replace(/\b([A-Za-z_][A-Za-z0-9_]*)_pos\b/g, (_a, name: string) => {
    const t = resolveName(name);
    return `pos_${t}`;
  });
  body = body.replace(/\b([A-Za-z_][A-Za-z0-9_]*)_size\b/g, (_a, name: string) => {
    const t = resolveName(name);
    return `size_${t}`;
  });
  body = body.replace(/\b([A-Za-z_][A-Za-z0-9_]*)_pt\b/g, (_a, name: string) => {
    const t = resolveName(name);
    return `pt_${t}`;
  });

  // ── ③ 采样函数调用 ──
  // 注意：参数里常有嵌套括号，如 `MAIN_texOff(vec2(i - KERNELHALFSIZE, 0))`，
  // 用 `[^)]*?` 会匹配不到（第一个 `)` 就截断了）。这里用「手动配平括号」来取参数。
  const takeArgs = (s: string, openIdx: number): { args: string; end: number } | null => {
    let depth = 0;
    for (let i = openIdx; i < s.length; i++) {
      const c = s[i];
      if (c === '(') depth++;
      else if (c === ')') {
        depth--;
        if (depth === 0) return { args: s.slice(openIdx + 1, i), end: i + 1 };
      }
    }
    return null;
  };

  const rewriteCall = (src: string, toFn: (name: string, off: boolean) => string): string => {
    // 顺序要紧：_texOff 必须先于 _tex 匹配，否则 `_tex(Off)?` 会把 `_texOff`
    // 的 Off 当成可选组吃掉，生成 `texOff_MAINOff` 这种鬼名字。
    const re = /\b([A-Za-z_][A-Za-z0-9_]*)_tex(Off)?\s*\(/g;
    let out = '';
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      const full = m[0];
      const isOff = m[2] === 'Off';
      const name = m[1];
      const openIdx = m.index + full.length - 1;
      const got = takeArgs(src, openIdx);
      if (!got) continue;
      out += src.slice(last, m.index);
      out += `${toFn(name, isOff)}(${got.args})`;
      last = got.end;
      re.lastIndex = got.end;
    }
    out += src.slice(last);
    return out;
  };

  body = rewriteCall(body, (name, isOff) => `${isOff ? 'texOff_' : 'tex_'}${resolveName(name)}`);

  // ── ④ hook() → main()，return X → gl_FragColor = X ──
  // ★ 只改 main() 内部的 return。shader 里还有 get_luma() 这类辅助函数，
  //   它们的 return 必须保留，否则函数变成 void 却返回值，编译直接失败。
  body = body.replace(/vec4\s+hook\s*\(\s*\)/, 'void main()');
  body = rewriteReturnsInMain(body);

  // ── ⑤ 数组下标：X_tex(...)[expr] → swizzle ──
  //
  // mpv 允许对 vec4 用 int 下标取分量，WebGL GLSL ES 1.00 **不允许**
  // （'Index expression must be constant'）—— Anime4K 的 Depth-to-Space
  // pass 就用了 `tex(...)[i0.y * 2 + i0.x]`，其中 i0 是运行时 ivec2。
  //
  // ★ 这里必须用**括号平衡扫描**而不是正则：
  //   - 调用的参数里有嵌套括号：`(vec2(0.5) - f0) * pt_x + pos_x`
  //     正则里的 `[^()]*` 匹配不到；
  //   - 下标是**表达式**不是单个标识符：`i0.y * 2 + i0.x`
  //     正则里的 `[A-Za-z_]\w*` 也匹配不到。
  //   两条正则都漏掉 → 原始写法留在 GLSL 里 → 着色器编译失败 →
  //   整个 Anime4K 档位静默失效（用户看到「点了没反应」）。
  body = rewriteDynamicVectorIndex(body);

  // ── ⑥ //!WHEN 条件 ──
  //
  // mpv 的条件语法是**后置比较符**，且子句之间没有显式分隔符：
  //   `OUTPUT.w MAIN.w / 1.200 > OUTPUT.h MAIN.h / 1.200 > *`
  // 读作两个子句：(OUTPUT.w > MAIN.w / 1.200) && (OUTPUT.h > MAIN.h / 1.200)
  //
  // ★ 末尾的 `*` 只是整个条件的结束符，不是子句分隔符。
  //   子句的模式固定为「变量A 变量B [运算符 常数] 比较符」，
  //   用一条正则就能逐个匹配出来。
  let cond = pass.when;
  if (cond) {
    // 变量：OUTPUT.w / OUTPUT.h / MAIN.w / MAIN.h / NATIVE.w / NATIVE.h
    const V = '(?:OUTPUT|MAIN|NATIVE)\\.[wh]';
    // 一个子句：A B [op 常数] cmp
    //   A/B 是尺寸变量；中间的 "/ k" 或 "* k" 是系数（可省略）
    const clauseRe = new RegExp(
      `(${V})\\s+(${V})\\s*(?:([*/])\\s*([0-9.]+)\\s*)?([<>])`,
      'g'
    );
    const clauses: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = clauseRe.exec(cond)) !== null) {
      const [, a, b, op, num, cmp] = m;
      const A = translateCondVar(a);
      const B = translateCondVar(b);
      // 有系数时右操作数是 B * num（或 B / num）
      const rhs = num !== undefined ? `(${B} ${op} ${num})` : B;
      clauses.push(`(${A} ${cmp} ${rhs})`);
    }
    cond = clauses.length ? clauses.join(' && ') : 'true';
  }

  // ── ⑦ 生成 uniform 与辅助函数 ──
  const helpers: string[] = [];
  // MAIN 恒定可见：mpv 里 MAIN 是「主输入」的隐式名字，
  // 即使本 pass 没显式 BIND MAIN，代码里也可能直接用 MAIN_texOff。
  // HOOKED 同样恒定可见：它是「本 hook 主输入」的别名。
  const visible = new Set(allBinds);
  visible.add('MAIN');
  visible.add('HOOKED');
  for (const b of visible) {
    helpers.push(`
uniform sampler2D uTex_${b};
uniform vec2 size_${b};
uniform vec2 pt_${b};
// ★ mpv 的 X_tex(pos) 里 pos 是**像素坐标**，而 WebGL 的 texture2D 要归一化坐标。
//   不换算的话采样点会落在纹理外的极远处，表现为「输出全黑」。
vec4 tex_${b}(vec2 pos) { return texture2D(uTex_${b}, pos / max(size_${b}, vec2(1.0))); }
vec4 texOff_${b}(vec2 off) { return texture2D(uTex_${b}, vUv + off * pt_${b}); }`);
  }
  // pos_X：当前采样点在 X 纹理中的像素坐标 = 归一化坐标 × 像素尺寸
  // 用宏展开成表达式，避免再多一个 uniform
  for (const b of visible) {
    helpers.push(`#define pos_${b} (vUv * size_${b})`);
  }
  // swizzle 辅助：把 vec4 的动态下标展开
  helpers.push(`
float swizzle4(vec4 v, int i) {
  if (i == 0) return v.x;
  if (i == 1) return v.y;
  if (i == 2) return v.z;
  return v.w;
}`);

  const head = `
precision highp float;
varying vec2 vUv;
uniform vec2 outSize;
uniform vec2 inSize;
uniform vec2 natSize;
#define outW outSize.x
#define outH outSize.y
#define inW inSize.x
#define inH inSize.y
#define natW natSize.x
#define natH natSize.y
${helpers.join('\n')}
`;

  // 条件包裹
  let mainBody = body;
  if (cond) {
    mainBody = mainBody.replace(/void\s+main\s*\(\s*\)/, 'void shaderMain()');
    mainBody += `
void main() {
  if (${cond}) { shaderMain(); } else { gl_FragColor = tex_MAIN(vUv); }
}`;
  }

  return head + mainBody;
}

/**
 * 把「函数调用结果」的动态下标改写成 swizzle4 调用。
 *
 * `tex_xxx(args)[expr]` → `swizzle4(tex_xxx(args), expr)`
 *
 * GLSL ES 1.00 的向量分量下标必须是常量表达式，mpv 的 GLSL（桌面 GL 4.x）
 * 则允许任意 int 表达式。Anime4K 的 Depth-to-Space pass 用了运行时的
 * `ivec2 i0` 做下标，直接搬到 WebGL 会编译失败：
 *   ERROR: '[]' : Index expression must be constant
 *
 * ★ 为什么不能用正则：
 *   1. 被下标的表达式里**有嵌套括号**：`(vec2(0.5) - f0) * pt_x + pos_x`
 *      —— `[^()]*` 匹配不到；
 *   2. 下标本身是**表达式**：`i0.y * 2 + i0.x` —— `[A-Za-z_]\w*` 匹配不到；
 *   3. 调用名在转换过程中**会变**（`X_tex(` → `tex_X(`），
 *      按名字写正则随时会漏。
 *   所以改成通用扫描：找所有 `[`，往前确认前面是函数调用，再看 `]` 里
 *   是不是常量下标。
 */
function rewriteDynamicVectorIndex(src: string): string {
  interface Hit { start: number; end: number; expr: string; idx: string }
  const hits: Hit[] = [];

  for (let i = 0; i < src.length; i++) {
    if (src[i] !== '[') continue;
    // 往前跳过空白，看是不是函数调用的右括号
    let j = i - 1;
    while (j >= 0 && /\s/.test(src[j])) j--;
    if (j < 0 || src[j] !== ')') continue;
    // 平衡括号找 '('
    let depth = 0;
    let k = j;
    for (; k >= 0; k--) {
      if (src[k] === ')') depth++;
      else if (src[k] === '(') {
        depth--;
        if (depth === 0) break;
      }
    }
    if (k < 0) continue;
    // 函数名
    let nameStart = k - 1;
    while (nameStart >= 0 && /[A-Za-z0-9_]/.test(src[nameStart])) nameStart--;
    const name = src.slice(nameStart + 1, k);
    if (!name) continue;
    // 找匹配的 ']'
    let d = 0;
    let e = i;
    for (; e < src.length; e++) {
      if (src[e] === '[') d++;
      else if (src[e] === ']') {
        d--;
        if (d === 0) break;
      }
    }
    if (e >= src.length) continue;
    const idx = src.slice(i + 1, e).trim();
    if (!idx) continue;
    // 纯数字下标本身合法
    if (/^\d+$/.test(idx)) continue;
    // ★ expr 只取**函数调用部分**（到匹配的右括号为止），
    //   不能把下标 `[...]` 也包进去 —— 否则生成的代码括号不闭合，
    //   编译报 ')' : syntax error。
    const callEnd = j + 1;
    hits.push({ start: nameStart + 1, end: e + 1, expr: src.slice(nameStart + 1, callEnd), idx });
    i = e;
  }

  if (!hits.length) return src;

  // 从后往前替换，避免偏移错乱
  let out = src;
  for (let i = hits.length - 1; i >= 0; i--) {
    const h = hits[i];
    out = out.slice(0, h.start) + `swizzle4(${h.expr}, ${h.idx})` + out.slice(h.end);
  }
  return out;
}
