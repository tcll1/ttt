/* global QWEATHER_HOST, QWEATHER_KEY */
/**
 * 城市天气查询脚本（原生 JS，无框架）
 * 依赖同目录 config.js 暴露的 QWEATHER_HOST / QWEATHER_KEY
 *
 * 请求地址模板：https://${QWEATHER_HOST}/v7/xxx?location=经度,纬度&key=...
 */
(function () {
  'use strict';

  /* ================= 1. 配置与常量 ================= */

  const CONFIG = (function readConfig() {
    const pick = (value) => (typeof value === 'string' && value.trim() ? value.trim() : '');
    // 通过 typeof 判断，避免 config.js 未引入时直接抛 ReferenceError
    const host = pick(typeof QWEATHER_HOST !== 'undefined' ? QWEATHER_HOST : '');
    const key = pick(typeof QWEATHER_KEY !== 'undefined' ? QWEATHER_KEY : '');
    return {
      // 容错：去掉可能被误填的协议头和结尾斜杠
      host: host.replace(/^https?:\/\//i, '').replace(/\/+$/, ''),
      key: key,
    };
  })();

  const REQUEST_TIMEOUT = 10000; // 单次请求超时（毫秒），超时主动中断，避免页面卡死
  const GEO_TIMEOUT = 15000; // 🆕 加大定位超时到 15s，给高精度 GPS 足够时间
  const FALLBACK_CITY = { lon: 112.93, lat: 28.23, label: '郴州' }; // 定位失败时的兜底城市

  /* ================= 2. DOM 引用 ================= */

  const dom = {
    form: document.getElementById('searchForm'),
    input: document.getElementById('cityInput'),
    searchBtn: document.getElementById('searchBtn'),
    locateBtn: document.getElementById('locateBtn'),
    status: document.getElementById('statusBar'),
    emptyTip: document.getElementById('emptyTip'),
    // 实时天气
    nowCard: document.getElementById('nowCard'),
    nowCity: document.getElementById('nowCity'),
    nowTemp: document.getElementById('nowTemp'),
    nowText: document.getElementById('nowText'),
    nowIcon: document.getElementById('nowIcon'),
    nowFeels: document.getElementById('nowFeels'),
    nowHumidity: document.getElementById('nowHumidity'),
    nowWind: document.getElementById('nowWind'),
    nowObs: document.getElementById('nowObs'),
    // 24 小时
    hourlyCard: document.getElementById('hourlyCard'),
    hourlyList: document.getElementById('hourlyList'),
    hourlyTip: document.getElementById('hourlyTip'),
    // 🆕 温度折线图
    hourlyChart: document.getElementById('hourlyChart'),
    hourlyChartWrap: document.getElementById('hourlyChartWrap'),
    // 7 天
    dailyCard: document.getElementById('dailyCard'),
    dailyList: document.getElementById('dailyList'),
    dailyTip: document.getElementById('dailyTip'),

    // ============ 🆕 新增模块 DOM 引用 ============
    // 昼夜切换
    themeToggle: document.getElementById('themeToggle'),
    // 日出日落
    sunCard: document.getElementById('sunCard'),
    sunriseTime: document.getElementById('sunriseTime'),
    sunsetTime: document.getElementById('sunsetTime'),
    // 穿衣与运动建议
    adviceCard: document.getElementById('adviceCard'),
    adviceCloth: document.getElementById('adviceCloth'),
    adviceSport: document.getElementById('adviceSport'),
    // 下雨提醒弹窗
    rainModal: document.getElementById('rainModal'),
    rainModalText: document.getElementById('rainModalText'),
    rainModalClose: document.getElementById('rainModalClose'),
    // 雨滴特效
    rainContainer: document.getElementById('rainContainer'),
    // 地图：缩略图 + 弹窗（双份 DOM）
    mapThumb: document.getElementById('mapThumb'),
    thumbPoints: document.getElementById('thumbPoints'),
    mapModal: document.getElementById('mapModal'),
    mapModalClose: document.getElementById('mapModalClose'),
    mapPoints: document.getElementById('mapPoints'),
    mapCityGrid: document.getElementById('mapCityGrid'),
    // 🆕 自动刷新状态条
    refreshBar: document.getElementById('refreshBar'),
    refreshText: document.getElementById('refreshText'),
    refreshCountdown: document.getElementById('refreshCountdown'),
    refreshNowBtn: document.getElementById('refreshNowBtn'),
  };

  /* ================= 3. 错误对象与中文文案 ================= */

  /** 统一的业务错误，携带 HTTP 状态码，便于区分 401 / 403 / 429 */
  class AppError extends Error {
    constructor(message, status) {
      super(message);
      this.name = 'AppError';
      this.status = status || 0;
    }
  }

  /** HTTP 状态码 -> 中文提示 */
  function httpErrorMessage(status) {
    if (status === 400) return '请求参数有误（400），请检查 location 是否按「经度,纬度」格式拼接';
    if (status === 401) return '密钥错误（401）：QWEATHER_KEY 无效或未通过认证，请检查 config.js';
    if (status === 403) return 'Host 无效（403）：QWEATHER_HOST 未授权、与 Key 不匹配或未加入白名单';
    if (status === 404) return '接口或城市不存在（404），请检查请求地址与查询关键词';
    if (status === 429) return '请求过于频繁（429）：已超出免费额度或触发限流，请稍后再试';
    if (status >= 500) return '和风天气服务异常（' + status + '），请稍后重试';
    return '请求失败（HTTP ' + status + '）';
  }

  /** 接口业务错误码（HTTP 200 但 code != 200）-> 中文提示 */
  function apiCodeMessage(code) {
    const map = {
      204: '该地区暂无天气数据（204），请换个城市试试',
      400: '请求参数错误（400），请检查 location 参数',
      401: '密钥错误（401）：请检查 config.js 中的 QWEATHER_KEY',
      402: '超过每日访问次数（402），请明天再试',
      403: '无访问权限（403）：请确认 QWEATHER_HOST 是控制台里的 API Host',
      404: '查询的城市或接口不存在（404）',
      429: '请求过于频繁（429），已被限流，请稍后再试',
      500: '和风天气服务端错误（500），请稍后重试',
    };
    return map[String(code)] || '接口返回错误码 ' + code;
  }

  /**
   * 读取错误响应体里的官方错误信息，转成中文；读不出来时退回状态码映射
   * 官方错误体：{"error":{"status":403,"title":"Invalid Host","detail":"..."}}
   */
  async function readErrorMessage(response) {
    const titleMap = {
      'Invalid Host': 'Host 无效或未授权（403）：请检查 config.js 里的 QWEATHER_HOST 是否为控制台显示的完整域名',
      'Invalid Key': '密钥无效（401）：请检查 config.js 里的 QWEATHER_KEY',
      'Authentication Failed': '密钥认证失败（401）：请检查 config.js 里的 QWEATHER_KEY',
      'No Such Location': '找不到该城市：请换个关键词，或使用准确的中文名 / 拼音',
      'Too Many Requests': '请求过于频繁（429），已被限流，请稍后再试',
      'Insufficient Balance': '账户额度不足，请到控制台确认订阅状态',
    };
    try {
      const body = await response.json();
      if (body && body.error && titleMap[body.error.title]) return titleMap[body.error.title];
    } catch (err) {
      // 某些网关返回空响应体（Content-Length: 0），忽略即可
    }
    return httpErrorMessage(response.status);
  }

  /** 把任意异常转成可展示的中文文案 */
  function errorText(err) {
    if (!err) return '未知错误';
    if (err instanceof AppError) return err.message;
    if (err.name === 'AbortError') return '请求超时，请检查网络后重试';
    return err.message || '未知错误';
  }

  /* ================= 4. 网络请求封装 ================= */

  /**
   * 发送 GET 请求并返回 JSON
   * 所有 fetch 都在 try-catch 内，且带超时中断，保证页面不会卡死
   */
  async function request(path, params) {
    if (!CONFIG.host) throw new AppError('未配置 QWEATHER_HOST，请先在 config.js 中填写 API Host');
    if (!CONFIG.key) throw new AppError('未配置 QWEATHER_KEY，请先在 config.js 中填写密钥');

    const query = new URLSearchParams(Object.assign({}, params, { key: CONFIG.key }));
    const url = 'https://' + CONFIG.host + path + '?' + query.toString();

    const controller = new AbortController();
    const timer = setTimeout(function () {
      controller.abort(); // 超时主动中断，避免请求一直挂起
    }, REQUEST_TIMEOUT);

    let response = null;
    try {
      response = await fetch(url, { method: 'GET', signal: controller.signal });
    } catch (err) {
      // AbortError = 超时；其他多为断网 / DNS 失败 / 跨域被拦截
      if (err && err.name === 'AbortError') {
        throw new AppError(
          '请求超时（' + REQUEST_TIMEOUT / 1000 + ' 秒）：多为系统代理 / VPN 拦截，请关闭代理或将该域名设为直连后重试'
        );
      }
      throw new AppError('网络连接失败，请检查网络是否可用、接口域名是否允许跨域');
    } finally {
      clearTimeout(timer);
    }

    // 先处理 HTTP 层错误：401 密钥 / 403 host / 429 限流
    if (!response.ok) {
      throw new AppError(await readErrorMessage(response), response.status);
    }

    let data = null;
    try {
      data = await response.json();
    } catch (err) {
      throw new AppError('返回数据格式异常，无法解析 JSON');
    }

    // 再处理和风天气业务错误码（部分错误以 HTTP 200 + code 返回）
    if (data && data.code && String(data.code) !== '200') {
      throw new AppError(apiCodeMessage(data.code), Number(data.code) || 0);
    }
    return data;
  }

  /* ================= 5. 界面工具函数 ================= */

  /** 提示条：message 为空则隐藏 */
  function showStatus(message, type) {
    if (!message) {
      dom.status.hidden = true;
      dom.status.textContent = '';
      dom.status.className = 'status';
      return;
    }
    dom.status.hidden = false;
    dom.status.textContent = message;
    dom.status.className = 'status status--' + (type || 'info');
  }

  /** 请求期间禁用按钮，防止重复点击 */
  function setBusy(busy) {
    dom.searchBtn.disabled = busy;
    dom.locateBtn.disabled = busy;
    dom.form.setAttribute('aria-busy', busy ? 'true' : 'false');
  }

  /** 创建元素（用 textContent 赋值，避免接口数据被当成 HTML 解析） */
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  /** 经度,纬度 —— 和风天气要求「经度在前、纬度在后」，且坐标最多两位小数 */
  function coordsOf(lon, lat) {
    return Number(lon).toFixed(2) + ',' + Number(lat).toFixed(2);
  }

  /** 从 ISO 时间中取 HH:mm（如 2026-10-28T15:00+08:00） */
  function formatHourMinute(iso) {
    const matched = /T(\d{2}):(\d{2})/.exec(iso || '');
    return matched ? matched[1] + ':' + matched[2] : '--';
  }

  /** 判断是否是夜间（用于选图标） */
  function isNight(iso) {
    const matched = /T(\d{2}):/.exec(iso || '');
    if (!matched) return false;
    const hour = Number(matched[1]);
    return hour >= 19 || hour < 6;
  }

  /** 2026-10-28 -> { date: '10-28', week: '周三' } */
  function formatDay(fxDate) {
    const parts = String(fxDate || '').split('-');
    if (parts.length !== 3) return { date: fxDate || '--', week: '' };
    const date = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
    const week = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][date.getDay()] || '';
    return { date: parts[1] + '-' + parts[2], week: week };
  }

  /** 和风天气图标代码 -> 简单 emoji（不引入外部图标字体，避免加载失败） */
  function weatherIcon(code, night) {
    const n = Number(code);
    // 🐾 可爱版 emoji：更圆润更萌的选择
    if (n === 100 || n === 150) return night ? '🌙' : '🌞';           // 晴天：圆脸太阳/月亮
    if ([101, 102, 103, 151, 152, 153].indexOf(n) !== -1) return '⛅'; // 多云
    if (n === 104 || n === 154) return '☁️';                           // 阴天
    if (n >= 302 && n <= 304) return '⛈️';                             // 雷暴
    if (n >= 300 && n <= 399) return '🌧️';                             // 雨
    if (n >= 400 && n <= 499) return '❄️';                             // 雪
    if (n >= 500 && n <= 515) return '🌫️';                             // 雾
    if (n === 900) return '🥵';                                         // 极热
    if (n === 901) return '🥶';                                         // 极寒
    return '🌤️';                                                         // 默认
  }

  /* ================= 6. 渲染 ================= */

  function renderNow(now, label) {
    dom.nowCity.textContent = label;
    dom.nowTemp.textContent = now.temp != null ? now.temp : '--';
    dom.nowText.textContent = now.text || '--';
    dom.nowIcon.textContent = weatherIcon(now.icon, isNight(now.obsTime));
    dom.nowFeels.textContent = now.feelsLike != null ? now.feelsLike + '°C' : '--';
    dom.nowHumidity.textContent = now.humidity != null ? now.humidity + '%' : '--';
    dom.nowWind.textContent =
      now.windDir && now.windScale ? now.windDir + ' ' + now.windScale + ' 级' : '--';
    dom.nowObs.textContent = formatHourMinute(now.obsTime);
    dom.nowCard.hidden = false;
  }

  function renderHourly(list) {
    dom.hourlyList.textContent = '';
    list.forEach(function (item) {
      const wrap = el('div', 'hour-item');
      wrap.appendChild(el('span', 'hour-time', formatHourMinute(item.fxTime)));
      wrap.appendChild(el('span', 'hour-icon', weatherIcon(item.icon, isNight(item.fxTime))));
      wrap.appendChild(el('span', 'hour-temp', item.temp != null ? item.temp + '°' : '--'));
      wrap.appendChild(el('span', 'hour-text', item.text || ''));
      dom.hourlyList.appendChild(wrap);
    });
    // 🆕 缓存数据 + 绘制折线图
    _lastHourlyList = list;
    drawHourlyChart(list);
  }

  function renderDaily(list) {
    dom.dailyList.textContent = '';
    list.forEach(function (item) {
      const day = formatDay(item.fxDate);
      const row = el('li', 'daily-item');

      // 日期 + 星期
      const dateCell = el('span', 'day-date', day.date);
      if (day.week) dateCell.appendChild(el('span', 'day-week', day.week));
      row.appendChild(dateCell);

      row.appendChild(el('span', 'day-icon', weatherIcon(item.icon, false)));
      row.appendChild(el('span', 'day-text', item.text || ''));

      // 最高温 / 最低温
      const tempCell = el('span', 'day-temp');
      tempCell.appendChild(el('b', null, item.tempMax != null ? item.tempMax + '°' : '--'));
      tempCell.appendChild(document.createTextNode(' / '));
      tempCell.appendChild(el('span', null, item.tempMin != null ? item.tempMin + '°' : '--'));
      row.appendChild(tempCell);

      // 风向风力（小屏由 CSS 隐藏）
      const wind = [(item.windDir || ''), item.windScaleDay ? item.windScaleDay + '级' : '']
        .join(' ')
        .trim();
      row.appendChild(el('span', 'day-wind', wind || '--'));

      dom.dailyList.appendChild(row);
    });
  }

  /* ================= 🆕 9b. 温度折线图（纯 Canvas 2D） ================= */

  /** 缓存最近一次 24 小时数据，resize / 主题切换时自动重绘 */
  let _lastHourlyList = null;

  /**
   * 用 Canvas 2D 绘制 24 小时温度折线图
   * - devicePixelRatio 自适应，解决高分屏模糊
   * - 纵向按 min/max 温度归一化，保证落差明显
   * - 平滑贝塞尔曲线 + 渐变填充
   */
  function drawHourlyChart(list) {
    if (!dom.hourlyChart || !dom.hourlyChartWrap || !Array.isArray(list) || !list.length) return;

    const canvas = dom.hourlyChart;
    const wrap = dom.hourlyChartWrap;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // 根据主题选颜色
    const isDark = document.body.getAttribute('data-theme') === 'dark';
    const lineColor = isDark ? '#fbbf24' : '#f97316';       // 折线：暖橙/金黄色
    const pointColor = isDark ? '#fbbf24' : '#ea580c';      // 圆点
    const labelColor = isDark ? '#cbd5e1' : '#475569';      // 温度文字
    const timeColor = isDark ? '#94a3b8' : '#94a3b8';       // 时间标签
    const fillTop = isDark ? 'rgba(251,191,36,0.35)' : 'rgba(249,115,22,0.3)';
    const fillBottom = isDark ? 'rgba(251,191,36,0)' : 'rgba(249,115,22,0)';

    // 读取容器实际尺寸
    const rect = wrap.getBoundingClientRect();
    const cssW = rect.width;
    const cssH = rect.height;
    if (cssW < 60 || cssH < 60) return; // 容器还没准备好

    // devicePixelRatio 物理像素缩放
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    canvas.style.width = cssW + 'px';
    canvas.style.height = cssH + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // 边距：上留出温度标签空间，下留出时间标签空间
    const padL = 6, padR = 6, padT = 22, padB = 18;
    const W = cssW - padL - padR;
    const H = cssH - padT - padB;

    // 抽取温度数据（过滤掉 null）
    const temps = list.map(function (i) { return i.temp != null ? Number(i.temp) : NaN; });
    const validTemps = temps.filter(function (t) { return !isNaN(t); });
    if (!validTemps.length) return;

    // 温度范围：预留 padding，保证折线不贴顶贴底
    let tMin = Math.min.apply(null, validTemps);
    let tMax = Math.max.apply(null, validTemps);
    const tPad = Math.max(1, Math.round((tMax - tMin) * 0.25));
    tMin -= tPad;
    tMax += tPad;
    const tRange = tMax - tMin || 1;

    // 坐标映射：温度 → y（y 轴向下，温度高 → y 小）
    function tempToY(t) {
      return padT + H - ((t - tMin) / tRange) * H;
    }
    // x：按索引均分
    function idxToX(i) {
      const n = list.length;
      if (n <= 1) return padL + W / 2;
      return padL + (i / (n - 1)) * W;
    }

    // 构建有效点集合（跳过 null）
    const points = [];
    for (let i = 0; i < temps.length; i++) {
      if (!isNaN(temps[i])) {
        points.push({ x: idxToX(i), y: tempToY(temps[i]), temp: temps[i], idx: i });
      }
    }
    if (points.length < 2) return;

    // 清空
    ctx.clearRect(0, 0, cssW, cssH);

    // --- 1. 画渐变填充区域（曲线下方） ---
    ctx.beginPath();
    // 用 Catmull-Rom → Bézier 平滑曲线
    ctx.moveTo(points[0].x, padT + H); // 左下角
    // 先画折线点的平滑曲线
    const smoothPath = buildSmoothPath(points);
    for (let i = 0; i < smoothPath.length; i++) {
      const p = smoothPath[i];
      if (p.type === 'move') ctx.moveTo(p.x, p.y);
      else if (p.type === 'bezier') ctx.bezierCurveTo(p.cp1x, p.cp1y, p.cp2x, p.cp2y, p.x, p.y);
      else ctx.lineTo(p.x, p.y);
    }
    // 闭合到底部
    ctx.lineTo(points[points.length - 1].x, padT + H);
    ctx.closePath();

    const grad = ctx.createLinearGradient(0, padT, 0, padT + H);
    grad.addColorStop(0, fillTop);
    grad.addColorStop(1, fillBottom);
    ctx.fillStyle = grad;
    ctx.fill();

    // --- 2. 画平滑折线 ---
    ctx.beginPath();
    for (let i = 0; i < smoothPath.length; i++) {
      const p = smoothPath[i];
      if (p.type === 'move') ctx.moveTo(p.x, p.y);
      else if (p.type === 'bezier') ctx.bezierCurveTo(p.cp1x, p.cp1y, p.cp2x, p.cp2y, p.x, p.y);
      else ctx.lineTo(p.x, p.y);
    }
    ctx.strokeStyle = lineColor;
    ctx.lineWidth = 2.5;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.stroke();

    // --- 3. 画数据点（圆点 + 温度值） ---
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      // 圆点外圈（白）+ 内圈（色），更可爱
      ctx.beginPath();
      ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.beginPath();
      ctx.arc(p.x, p.y, 2.5, 0, Math.PI * 2);
      ctx.fillStyle = pointColor;
      ctx.fill();

      // 温度文字（只在首、尾、极值、或每隔几个显示，避免拥挤）
      const show =
        i === 0 ||
        i === points.length - 1 ||
        p.temp === tMin + tPad || // 最低点
        p.temp === tMax - tPad || // 最高点
        i % Math.max(1, Math.floor(points.length / 6)) === 0;
      if (show) {
        ctx.font = 'bold 11px system-ui, -apple-system, sans-serif';
        ctx.fillStyle = labelColor;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        ctx.fillText(Math.round(p.temp) + '°', p.x, p.y - 7);
      }
    }

    // --- 4. x 轴时间标签（每 3 小时显示一个） ---
    ctx.font = '10px system-ui, -apple-system, sans-serif';
    ctx.fillStyle = timeColor;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const step = Math.max(1, Math.floor(list.length / 8));
    for (let i = 0; i < list.length; i += step) {
      const iso = list[i].fxTime || '';
      const m = /T(\d{2}):/.exec(iso);
      const label = m ? m[1] + ':00' : formatHourMinute(iso);
      ctx.fillText(label, idxToX(i), padT + H + 4);
    }
  }

  /**
   * Catmull-Rom → Cubic Bézier 平滑路径
   * 给定 n 个点，返回一组 {type:'move'|'bezier'|'line', ...} 指令
   */
  function buildSmoothPath(points) {
    const result = [];
    if (!points.length) return result;
    if (points.length === 1) {
      result.push({ type: 'move', x: points[0].x, y: points[0].y });
      return result;
    }
    result.push({ type: 'move', x: points[0].x, y: points[0].y });

    for (let i = 0; i < points.length - 1; i++) {
      const p0 = points[i - 1] || points[i];
      const p1 = points[i];
      const p2 = points[i + 1];
      const p3 = points[i + 2] || p2;

      const cp1x = p1.x + (p2.x - p0.x) / 6;
      const cp1y = p1.y + (p2.y - p0.y) / 6;
      const cp2x = p2.x - (p3.x - p1.x) / 6;
      const cp2y = p2.y - (p3.y - p1.y) / 6;

      result.push({ type: 'bezier', cp1x: cp1x, cp1y: cp1y, cp2x: cp2x, cp2y: cp2y, x: p2.x, y: p2.y });
    }
    return result;
  }

  /* ================= 🆕 10. 日出日落 ================= */

  /** 格式化日期为 YYYYMMDD（和风天气 astronomy 接口要求） */
  function formatToday() {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return '' + y + m + day;
  }

  /** 渲染日出日落时间 */
  function renderSun(sunData) {
    if (!sunData) {
      dom.sunCard.hidden = true;
      return;
    }
    // 和风天气 astronomy/sun 返回格式可能是：
    //  - { sunrise: "06:23", sunset: "18:15" } (纯时间)
    //  - { sunrise: "2026-10-28T06:36+08:00", sunset: "2026-10-28T17:47+08:00" } (ISO 格式)
    // 统一格式化为 HH:mm
    function fmt(raw) {
      if (!raw) return '--';
      const s = String(raw).trim();
      // 如果包含 T，说明是 ISO 格式
      if (s.indexOf('T') !== -1) {
        const m = /T(\d{2}:\d{2})/.exec(s);
        return m ? m[1] : s;
      }
      // 如果本身就是 HH:mm 或 HH:MM:SS
      const parts = s.split(':');
      if (parts.length >= 2) return parts[0] + ':' + parts[1];
      return s;
    }
    dom.sunriseTime.textContent = fmt(sunData.sunrise);
    dom.sunsetTime.textContent = fmt(sunData.sunset);
    dom.sunCard.hidden = false;
  }

  /* ================= 🆕 11. 下雨识别与弹窗 ================= */

  /**
   * 判断天气代码是否为下雨
   * 和风天气 icon code：300-399 为降雨
   */
  function isRainy(code) {
    const n = Number(code);
    return n >= 300 && n <= 399;
  }

  /** 显示下雨提醒弹窗（每个天气周期只弹一次，避免骚扰） */
  let rainModalShownThisSession = false;
  function showRainModal(text) {
    if (rainModalShownThisSession) return;
    rainModalShownThisSession = true;
    dom.rainModalText.textContent = text || '当前城市正在下雨，请记得带伞 🌂';
    dom.rainModal.hidden = false;
  }

  function hideRainModal() {
    dom.rainModal.hidden = true;
  }

  /** 根据当前天气设置 body[data-weather] 以触发 CSS 样式变化 */
  function applyWeatherTheme(now) {
    if (now && isRainy(now.icon)) {
      document.body.setAttribute('data-weather', 'rain');
      // 生成雨滴特效 DOM
      ensureRainDrops();
      // 触发下雨弹窗（延迟 600ms，等用户看到页面数据后）
      setTimeout(function () {
        showRainModal('当前城市「' + (now.text || '降雨') + '」，请记得带伞 🌂');
      }, 600);
    } else {
      document.body.removeAttribute('data-weather');
    }
  }

  /* ================= 🆕 12. 雨滴特效生成（性能优化：40颗） ================= */

  let rainDropsGenerated = false;
  function ensureRainDrops() {
    if (rainDropsGenerated) return;
    rainDropsGenerated = true;
    // 🆕 性能优化：只生成 40 颗（原 80 颗），配合 will-change 独立层渲染
    const frag = document.createDocumentFragment();
    for (let i = 0; i < 40; i++) {
      const drop = document.createElement('div');
      drop.className = 'rain-drop';
      const left = Math.random() * 100;
      const delay = Math.random() * 2;
      const dur = 0.8 + Math.random() * 0.8;
      drop.style.left = left + '%';
      drop.style.animationDelay = delay + 's';
      drop.style.animationDuration = dur + 's';
      drop.style.opacity = 0.25 + Math.random() * 0.4;
      frag.appendChild(drop);
    }
    dom.rainContainer.appendChild(frag);
  }

  /* ================= 🆕 13. 昼夜模式切换 ================= */

  const THEME_KEY = 'weather-app-theme';

  function applyTheme(theme) {
    if (theme === 'dark') {
      document.body.setAttribute('data-theme', 'dark');
      dom.themeToggle.textContent = '☀️';
      dom.themeToggle.title = '切换到日间模式';
    } else {
      document.body.removeAttribute('data-theme');
      dom.themeToggle.textContent = '🌙';
      dom.themeToggle.title = '切换到深色模式';
    }
  }

  function getStoredTheme() {
    try {
      return localStorage.getItem(THEME_KEY);
    } catch (e) {
      return null;
    }
  }

  function storeTheme(theme) {
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch (e) {
      // localStorage 不可用时忽略
    }
  }

  function toggleTheme() {
    const isDark = document.body.getAttribute('data-theme') === 'dark';
    const next = isDark ? 'light' : 'dark';
    applyTheme(next);
    storeTheme(next);
    // 🆕 主题切换后重绘折线图（颜色依赖主题）
    if (_lastHourlyList) drawHourlyChart(_lastHourlyList);
  }

  /* ================= 🆕 14. 全国天气地图（缩略图 + 弹窗，懒加载天气） ================= */

  /**
   * 12 个基础城市点位，坐标为 SVG viewBox (0~600, 0~500) 内的近似位置
   */
  const MAP_CITIES = [
    { name: '哈尔滨',  x: 470, y: 95,  lon: 126.64, lat: 45.75 },
    { name: '北京',    x: 390, y: 155, lon: 116.40, lat: 39.90 },
    { name: '西安',    x: 275, y: 230, lon: 108.94, lat: 34.26 },
    { name: '上海',    x: 470, y: 270, lon: 121.47, lat: 31.23 },
    { name: '成都',    x: 235, y: 310, lon: 104.07, lat: 30.67 },
    { name: '郴州',    x: 325, y: 365, lon: 112.93, lat: 25.77 },
    { name: '广州',    x: 370, y: 430, lon: 113.26, lat: 23.13 },
    { name: '深圳',    x: 395, y: 440, lon: 114.06, lat: 22.55 },
    { name: '杭州',    x: 455, y: 300, lon: 120.15, lat: 30.28 },
    { name: '武汉',    x: 355, y: 305, lon: 114.31, lat: 30.52 },
    { name: '乌鲁木齐', x: 130, y: 155, lon: 87.62,  lat: 43.79 },
    { name: '昆明',    x: 180, y: 395, lon: 102.71, lat: 25.04 },
  ];

  /** 地图点位天气 emoji 缓存（弹窗打开时才真正请求） */
  const MAP_WEATHER_CACHE = {};
  let mapModalLoaded = false; // 弹窗天气数据是否已加载

  /** 🆕 初始化缩略图点位（只渲染空红点，不拉天气数据） */
  function initMapThumb() {
    if (!dom.thumbPoints) return;
    dom.thumbPoints.textContent = '';
    MAP_CITIES.forEach(function (city) {
      const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      g.setAttribute('transform', 'translate(' + city.x + ',' + city.y + ')');
      const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      circle.setAttribute('r', '3.5');
      circle.setAttribute('fill', '#ef4444');
      g.appendChild(circle);
      dom.thumbPoints.appendChild(g);
    });
  }

  /** 🆕 打开地图弹窗（懒加载：首次打开才请求天气） */
  async function openMapModal() {
    if (dom.mapModal) dom.mapModal.hidden = false;
    if (mapModalLoaded) return; // 已经加载过，直接显示
    mapModalLoaded = true;
    renderMapPoints(); // 渲染弹窗里的 SVG 点位 + 城市列表
    // 懒加载所有点位天气（并行，但不阻塞 UI）
    MAP_CITIES.forEach(function (city) {
      loadMapPointWeather(city);
    });
  }

  function closeMapModal() {
    if (dom.mapModal) dom.mapModal.hidden = true;
  }

  /** 渲染弹窗里的 SVG 点位 + 城市列表骨架 */
  function renderMapPoints() {
    if (!dom.mapPoints) return;
    dom.mapPoints.textContent = '';
    if (dom.mapCityGrid) dom.mapCityGrid.textContent = '';

    MAP_CITIES.forEach(function (city) {
      // SVG 点位
      const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      g.setAttribute('class', 'map-point');
      g.setAttribute('transform', 'translate(' + city.x + ',' + city.y + ')');
      g.dataset.name = city.name;

      const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      circle.setAttribute('r', '6');
      circle.setAttribute('fill', '#cbd5e1');
      circle.setAttribute('stroke', '#fff');
      circle.setAttribute('stroke-width', '1.5');
      g.appendChild(circle);

      const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      label.setAttribute('y', '-10');
      label.setAttribute('text-anchor', 'middle');
      label.textContent = city.name;
      g.appendChild(label);

      dom.mapPoints.appendChild(g);

      // 列表里的城市卡片（骨架）
      if (dom.mapCityGrid) {
        const card = el('div', 'map-city-card');
        card.dataset.name = city.name;
        card.addEventListener('click', function () {
          dom.input.value = city.name;
          closeMapModal();
          dom.form.requestSubmit ? dom.form.requestSubmit() : dom.form.dispatchEvent(new Event('submit'));
        });
        card.appendChild(el('span', 'map-city-emoji', '⏳'));
        const info = el('div', 'map-city-info');
        info.appendChild(el('span', 'map-city-name', city.name));
        info.appendChild(el('span', 'map-city-temp', '加载中…'));
        card.appendChild(info);
        dom.mapCityGrid.appendChild(card);
      }

      // 点位点击也能触发查询
      g.addEventListener('click', function () {
        dom.input.value = city.name;
        closeMapModal();
        dom.form.requestSubmit ? dom.form.requestSubmit() : dom.form.dispatchEvent(new Event('submit'));
      });
    });
  }

  /** 🆕 加载单个地图点位的天气（懒加载 + 缓存，单个失败不影响其他） */
  async function loadMapPointWeather(city) {
    const cacheKey = city.name;
    if (MAP_WEATHER_CACHE[cacheKey]) {
      updateMapPointUI(city, MAP_WEATHER_CACHE[cacheKey]);
      return;
    }
    try {
      const data = await request('/v7/weather/now', {
        location: coordsOf(city.lon, city.lat),
      });
      if (data && data.now) {
        const icon = weatherIcon(data.now.icon, false);
        const temp = data.now.temp != null ? data.now.temp + '°' : '--';
        const text = data.now.text || '';
        MAP_WEATHER_CACHE[cacheKey] = { icon: icon, temp: temp, text: text };
        updateMapPointUI(city, MAP_WEATHER_CACHE[cacheKey]);
      }
    } catch (err) {
      // 静默失败，把点位变灰
      updateMapPointUI(city, { icon: '❓', temp: '--', text: '加载失败' });
    }
  }

  /** 更新 SVG 点位 + 列表卡片 */
  function updateMapPointUI(city, info) {
    // SVG 点位：通过 name 找到对应 g 元素
    if (dom.mapPoints) {
      const gs = dom.mapPoints.querySelectorAll('g.map-point');
      for (let i = 0; i < gs.length; i++) {
        if (gs[i].dataset.name === city.name) {
          const circles = gs[i].querySelectorAll('circle');
          const texts = gs[i].querySelectorAll('text');
          if (circles[0]) circles[0].setAttribute('fill', info.icon === '🌧️' ? '#3b82f6' : '#ef4444');
          if (texts[0]) texts[0].textContent = info.icon + ' ' + city.name;
          break;
        }
      }
    }
    // 列表卡片
    if (dom.mapCityGrid) {
      const cards = dom.mapCityGrid.querySelectorAll('.map-city-card');
      for (let i = 0; i < cards.length; i++) {
        if (cards[i].dataset.name === city.name) {
          const emojis = cards[i].querySelectorAll('.map-city-emoji');
          const temps = cards[i].querySelectorAll('.map-city-temp');
          if (emojis[0]) emojis[0].textContent = info.icon;
          if (temps[0]) temps[0].textContent = info.temp + ' · ' + info.text;
          break;
        }
      }
    }
  }

  /* ================= 🆕 15. 穿衣 & 运动建议 ================= */

  /** 穿衣建议 —— 根据温度 + 天气代码 + 风力综合判断 */
  function getClothAdvice(temp, weatherCode, windScale) {
    const t = Number(temp);
    const rainy = isRainy(weatherCode);
    const snowy = Number(weatherCode) >= 400 && Number(weatherCode) <= 499;
    const windy = Number(windScale) >= 5;

    if (t <= 0)      return snowy ? '严寒，建议羽绒服+加绒裤，外出戴帽子手套🧣' : '严寒，厚羽绒服+保暖内衣，注意防寒';
    if (t <= 5)      return '很冷，建议厚外套或羽绒服，内穿毛衣/抓绒衫';
    if (t <= 10)     return '较冷，建议薄羽绒服或厚外套，内穿长袖+薄毛衣';
    if (t <= 15)     return '偏凉，建议夹克/风衣+长袖T恤，早晚加外套';
    if (t <= 20)     return '舒适，建议长袖T恤+薄外套，早晚温差留意';
    if (t <= 25)     return '温暖，建议短袖或薄长袖，中午可脱外套';
    if (t <= 30)     return '较热，建议短袖短裤，注意防晒补水';
    return '高温酷热，建议透气短袖短裤，避免长时间户外，多补水防晒';
  }

  /** 运动建议 */
  function getSportAdvice(temp, weatherCode, windScale) {
    const t = Number(temp);
    const rainy = isRainy(weatherCode);
    const snowy = Number(weatherCode) >= 400 && Number(weatherCode) <= 499;
    const windy = Number(windScale) >= 5;
    const foggy = Number(weatherCode) >= 500 && Number(weatherCode) <= 515;

    if (rainy)  return '下雨了，建议室内瑜伽/跑步机，或带伞快走（防滑）';
    if (snowy)  return '有雪，建议室内运动；如需外出请穿防滑鞋';
    if (foggy)  return '雾霾，建议室内运动，避免户外运动影响呼吸';
    if (windy)  return '风力较大，建议室内运动，或顺风骑行/放风筝';
    if (t <= 5) return '气温低，建议室内运动或冬季专项（滑雪/滑冰）';
    if (t <= 15) return '温度适宜，适合户外跑步、骑行、球类运动';
    if (t <= 28) return '温度适中，非常适合户外跑步、骑行、散步';
    if (t <= 33) return '较热，建议清晨/傍晚户外运动，避免烈日时段';
    return '高温酷暑，建议室内运动，或早6点前/晚8点后户外';
  }

  /** 渲染穿衣 & 运动建议 */
  function renderAdvice(now) {
    if (!now) return;
    const temp = now.temp != null ? now.temp : 20;
    const wind = now.windScale || 0;
    const cloth = getClothAdvice(temp, now.icon, wind);
    const sport = getSportAdvice(temp, now.icon, wind);
    dom.adviceCloth.textContent = cloth;
    dom.adviceSport.textContent = sport;
    dom.adviceCard.hidden = false;
  }

  /* ================= 🆕 16. 自动刷新（每 5 分钟） ================= */

  const REFRESH_INTERVAL = 5 * 60; // 5 分钟 = 300 秒
  let refreshTimer = null;
  let countdownTimer = null;
  let countdown = REFRESH_INTERVAL;
  let lastRefreshLoc = null; // 记录当前正在跟踪的 location 字符串

  /** 启动自动刷新 */
  function startAutoRefresh(locationStr) {
    stopAutoRefresh();
    lastRefreshLoc = locationStr;
    countdown = REFRESH_INTERVAL;

    if (dom.refreshBar) dom.refreshBar.hidden = false;
    if (dom.refreshText) dom.refreshText.textContent = '每 5 分钟自动刷新';
    updateCountdown();

    // 倒计时每秒更新
    countdownTimer = setInterval(updateCountdown, 1000);
    // 5 分钟到点执行刷新
    refreshTimer = setInterval(function () {
      if (lastRefreshLoc) {
        loadWeather(lastRefreshLoc, {});
        countdown = REFRESH_INTERVAL; // 重置倒计时
      }
    }, REFRESH_INTERVAL * 1000);
  }

  /** 停止自动刷新 */
  function stopAutoRefresh() {
    if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
    if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
    if (dom.refreshBar) dom.refreshBar.hidden = true;
  }

  /** 更新倒计时显示 */
  function updateCountdown() {
    if (!dom.refreshCountdown) return;
    const m = Math.floor(countdown / 60);
    const s = countdown % 60;
    dom.refreshCountdown.textContent = String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
    if (countdown > 0) countdown--;
  }

  /** 手动立即刷新按钮 */
  function refreshNow() {
    if (lastRefreshLoc) {
      loadWeather(lastRefreshLoc, {});
      countdown = REFRESH_INTERVAL; // 手动刷完重置倒计时
    }
  }

  /* ================= 7. 数据加载（扩展版） ================= */

  /**
   * 城市搜索：优先 v7 路径，若该路径在当前账号下不存在（404）则回退官方 GeoAPI 路径
   */
  async function cityLookup(keyword) {
    // 实测：/v7/city/lookup 在专属 Host 下返回 404，官方可用路径是 /geo/v2/city/lookup
    try {
      return await request('/geo/v2/city/lookup', { location: keyword, number: 5, lang: 'zh' });
    } catch (err) {
      if (err && err.status === 404) {
        return await request('/v7/city/lookup', { location: keyword, number: 5, lang: 'zh' });
      }
      throw err;
    }
  }

  /** 用坐标反查城市名（辅助请求，失败不影响主流程） */
  async function resolveCityLabel(location) {
    try {
      const data = await cityLookup(location);
      const city = (data.location || [])[0];
      if (!city) return '';
      // 去掉重复项，如「郴州 · 郴州」
      return [city.name, city.adm2, city.adm1]
        .filter(function (value, index, arr) {
          return value && arr.indexOf(value) === index;
        })
        .join(' · ');
    } catch (err) {
      console.warn('[weather] 城市名解析失败：', errorText(err));
      return '';
    }
  }

  /**
   * 按坐标加载实时 / 24 小时 / 7 天天气
   * @param {string} location 形如 "112.9300,28.2300"
   * @param {object} options { name: 已知城市名, fallbackName: 兜底名称, note: 成功后的提示文案 }
   */
  async function loadWeather(location, options) {
    const opts = options || {};
    setBusy(true);
    showStatus('正在获取天气数据…', 'info');

    try {
      // 🆕 新增：日出日落接口；五个接口互不依赖，并行请求
      const results = await Promise.allSettled([
        request('/v7/weather/now', { location: location }),
        request('/v7/weather/24h', { location: location }),
        request('/v7/weather/7d', { location: location }),
        // 🆕 日出日落（date 取今天，格式 YYYYMMDD）
        request('/v7/astronomy/sun', { location: location, date: formatToday() }),
        opts.name ? Promise.resolve(opts.name) : resolveCityLabel(location),
      ]);

      const nowRes = results[0];
      const hourlyRes = results[1];
      const dailyRes = results[2];
      const sunRes = results[3];   // 🆕
      const nameRes = results[4];

      const label =
        (nameRes.status === 'fulfilled' && nameRes.value) || opts.fallbackName || '当前位置';

      // 实时天气
      const hasNow = nowRes.status === 'fulfilled' && !!(nowRes.value && nowRes.value.now);
      if (hasNow) {
        renderNow(nowRes.value.now, label);
        // 天气联动：背景 / 下雨弹窗 / 雨滴特效
        applyWeatherTheme(nowRes.value.now);
        // 🆕 穿衣 & 运动建议
        renderAdvice(nowRes.value.now);
        // 🆕 启动自动刷新（每 5 分钟），记住当前 location
        startAutoRefresh(location);
        // 重置下雨弹窗标记 —— 换城市后可再次触发
        rainModalShownThisSession = false;
      } else {
        dom.nowCard.hidden = true;
        dom.adviceCard.hidden = true;
      }

      // 🆕 日出日落渲染
      if (sunRes.status === 'fulfilled' && sunRes.value) {
        // 和风天气 astronomy/sun 返回结构：{ sunrise, sunset }
        // 有些账号可能是 sunRes.value.sun 对象，这里兼容两种
        const sunData = sunRes.value.sun || sunRes.value;
        renderSun(sunData);
      } else {
        dom.sunCard.hidden = true;
      }

      // 24 小时预报
      const hasHourly =
        hourlyRes.status === 'fulfilled' &&
        !!hourlyRes.value &&
        Array.isArray(hourlyRes.value.hourly) &&
        hourlyRes.value.hourly.length > 0;
      if (hasHourly) {
        renderHourly(hourlyRes.value.hourly);
        dom.hourlyTip.hidden = true;
      } else {
        dom.hourlyList.textContent = '';
        dom.hourlyTip.hidden = false;
        dom.hourlyTip.textContent =
          '24 小时预报获取失败：' +
          errorText(hourlyRes.reason || new AppError('接口未返回数据'));
      }
      dom.hourlyCard.hidden = false;

      // 7 天预报
      const hasDaily =
        dailyRes.status === 'fulfilled' &&
        !!dailyRes.value &&
        Array.isArray(dailyRes.value.daily) &&
        dailyRes.value.daily.length > 0;
      if (hasDaily) {
        renderDaily(dailyRes.value.daily);
        dom.dailyTip.hidden = true;
      } else {
        dom.dailyList.textContent = '';
        dom.dailyTip.hidden = false;
        dom.dailyTip.textContent =
          '7 天预报获取失败：' + errorText(dailyRes.reason || new AppError('接口未返回数据'));
      }
      dom.dailyCard.hidden = false;

      // 全局提示：实时天气失败优先报错（401/403/429/断网都会走这里）
      if (nowRes.status === 'rejected') {
        showStatus(errorText(nowRes.reason), 'error');
      } else if (opts.note) {
        showStatus(opts.note, 'warn');
      } else {
        showStatus('');
      }

      // 是否有任何数据可以展示：有数据就隐藏空状态，全部失败则显示引导文案
      const hasAnyData = hasNow || hasHourly || hasDaily;
      dom.emptyTip.hidden = hasAnyData;
      if (!hasAnyData) dom.emptyTip.textContent = '暂时获取不到数据，请更换城市或稍后重试';
    } finally {
      setBusy(false);
    }
  }

  /* ================= 8. 搜索与定位 ================= */

  /** 城市搜索：先查坐标，再查天气 */
  async function handleSearch(event) {
    event.preventDefault();

    const keyword = dom.input.value.trim();
    if (!keyword) {
      showStatus('请输入城市名称，例如：郴州、北京', 'warn');
      dom.input.focus();
      return;
    }

    setBusy(true);
    showStatus('正在搜索城市…', 'info');

    try {
      const data = await cityLookup(keyword);
      const list = data.location || [];
      if (!list.length) {
        throw new AppError('没有找到「' + keyword + '」，请检查城市名称或换个关键词');
      }

      const city = list[0];
      if (city.lat == null || city.lon == null) {
        throw new AppError('该城市缺少经纬度信息，无法查询天气');
      }

      // 城市显示名：城市 + 上级区县/省份（去重）
      const name = [city.name, city.adm2, city.adm1]
        .filter(function (value, index, arr) {
          return value && arr.indexOf(value) === index;
        })
        .join(' · ');

      await loadWeather(coordsOf(city.lon, city.lat), { name: name });
    } catch (err) {
      showStatus(errorText(err), 'error');
      console.error('[weather] 城市搜索失败：', err);
    } finally {
      setBusy(false);
    }
  }

  /** 浏览器定位错误码 -> 中文原因 */
  function geoErrorMessage(err) {
    if (!err) return '定位失败';
    switch (err.code) {
      case 1:
        return '定位权限被拒绝';
      case 2:
        return '无法获取位置信息';
      case 3:
        return '定位超时';
      default:
        return '定位失败';
    }
  }

  /**
   * 获取当前位置（永不 reject，任何异常都以 ok:false 返回）
   * 自带兜底计时器：即使浏览器不回调，也会按时结束，保证页面不卡死
   */
  function getPosition() {
    return new Promise(function (resolve) {
      if (!navigator.geolocation) {
        resolve({ ok: false, reason: '当前浏览器不支持定位' });
        return;
      }

      let settled = false;
      let guard = null;

      function finish(result) {
        if (settled) return;
        settled = true;
        if (guard) clearTimeout(guard);
        resolve(result);
      }

      guard = setTimeout(function () {
        finish({ ok: false, reason: '定位超时' });
      }, GEO_TIMEOUT + 2000);

      navigator.geolocation.getCurrentPosition(
        function (pos) {
          finish({ ok: true, lon: pos.coords.longitude, lat: pos.coords.latitude });
        },
        function (err) {
          finish({ ok: false, reason: geoErrorMessage(err) });
        },
        // 🆕 启用高精度定位（GPS），不从缓存取（maximumAge: 0）
        // timeout 给 15s，让 GPS 有足够时间搜到卫星
        { enableHighAccuracy: true, timeout: GEO_TIMEOUT, maximumAge: 0 }
      );
    });
  }

  /** 定位按钮：拒绝 / 超时 / 不支持 都自动回退郴州，流程照常走完 */
  async function handleLocate() {
    setBusy(true);

    // 浏览器只在 https 或 localhost 下开放定位；file:// 和局域网 IP（如 192.168.x.x）会被直接禁用
    if (!window.isSecureContext) {
      dom.input.value = FALLBACK_CITY.label;
      await loadWeather(coordsOf(FALLBACK_CITY.lon, FALLBACK_CITY.lat), {
        name: FALLBACK_CITY.label,
        note: '当前页面不是 localhost / https，浏览器禁用了定位，已自动回退到郴州',
      });
      return;
    }

    showStatus('正在获取定位…', 'info');

    let pos = null;
    try {
      pos = await getPosition();
    } catch (err) {
      pos = { ok: false, reason: '定位异常' };
    }

    if (!pos.ok) {
      // 兜底：回退到郴州（112.93, 28.23）
      dom.input.value = FALLBACK_CITY.label;
      await loadWeather(coordsOf(FALLBACK_CITY.lon, FALLBACK_CITY.lat), {
        name: FALLBACK_CITY.label,
        note: '定位失败（' + pos.reason + '），已自动回退到郴州',
      });
      return;
    }

    await loadWeather(coordsOf(pos.lon, pos.lat), { fallbackName: '当前位置' });
  }

  /* ================= 9. 初始化 ================= */

  function init() {
    // 🆕 紧急修复：强制清理所有弹窗的脏状态（防止之前调试脚本或浏览器缓存
    //   把 hidden 属性干掉导致全屏遮罩盖死所有点击）
    if (dom.rainModal) dom.rainModal.hidden = true;
    if (dom.mapModal) dom.mapModal.hidden = true;
    if (dom.rainContainer) dom.rainContainer.style.opacity = '0';
    if (document.body) document.body.removeAttribute('data-weather');

    dom.form.addEventListener('submit', handleSearch);
    dom.locateBtn.addEventListener('click', handleLocate);

    // 🆕 昼夜模式：恢复用户上次选择的主题
    const savedTheme = getStoredTheme();
    applyTheme(savedTheme === 'dark' ? 'dark' : 'light');

    // 🆕 绑定主题切换按钮
    if (dom.themeToggle) {
      dom.themeToggle.addEventListener('click', toggleTheme);
    }

    // 🆕 下雨弹窗关闭按钮
    if (dom.rainModalClose) {
      dom.rainModalClose.addEventListener('click', hideRainModal);
    }
    if (dom.rainModal) {
      dom.rainModal.addEventListener('click', function (e) {
        if (e.target === dom.rainModal) hideRainModal();
      });
    }

    // 🆕 地图缩略图点击打开弹窗（懒加载天气数据，避免首次卡顿）
    initMapThumb(); // 只渲染缩略图里的空红点
    if (dom.mapThumb) {
      dom.mapThumb.addEventListener('click', openMapModal);
    }
    // 🆕 地图弹窗关闭
    if (dom.mapModalClose) {
      dom.mapModalClose.addEventListener('click', closeMapModal);
    }
    if (dom.mapModal) {
      dom.mapModal.addEventListener('click', function (e) {
        if (e.target === dom.mapModal) closeMapModal();
      });
    }
    // 🆕 自动刷新：立即刷新按钮
    if (dom.refreshNowBtn) {
      dom.refreshNowBtn.addEventListener('click', refreshNow);
    }
    // 🆕 ESC 关闭弹窗
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        closeMapModal();
        hideRainModal();
      }
    });
    // 🆕 resize 防抖重绘折线图（容器宽度变了）
    let _resizeTimer = null;
    window.addEventListener('resize', function () {
      if (_resizeTimer) clearTimeout(_resizeTimer);
      _resizeTimer = setTimeout(function () {
        if (_lastHourlyList) drawHourlyChart(_lastHourlyList);
      }, 120);
    });

    // 配置缺失或明显异常时，直接给出中文提示，而不是留一片白屏
    if (!CONFIG.host || !CONFIG.key) {
      showStatus('尚未配置 QWEATHER_HOST / QWEATHER_KEY，请先在同目录 config.js 中填写', 'error');
      dom.emptyTip.textContent = '配置完成后即可查询天气';
      return;
    }

    if (!/^[\w.-]+$/.test(CONFIG.host)) {
      showStatus('QWEATHER_HOST 格式不正确，应形如 xxxx.re.qweatherapi.com（不带 https:// 与路径）', 'error');
    }
  }

  init();
})();