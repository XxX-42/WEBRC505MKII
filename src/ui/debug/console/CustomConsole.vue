<template>
  <!-- 自定义日志输出容器，id 和 class 均为 custom-console -->
  <div id="custom-console" class="custom-console"></div>
</template>

<script setup lang="ts">
import { onMounted } from 'vue'

/**
 * overrideConsole - 重写 console.log/error/warn 方法
 * 1. 将日志写入自定义容器中
 * 2. 在容器背景中显示大字 "LOG"
 * 3. 根据日志行数动态调整背景 "LOG" 的透明度
 */
function overrideConsole() {
  // 保存原始的 console 方法，便于在重写后依然能输出到浏览器控制台
  const originalLog = console.log;
  const originalError = console.error;
  const originalWarn = console.warn;

  // 获取页面中 id 为 "custom-console" 的元素
  let consoleDiv = document.getElementById("custom-console");
  // 如果找不到，则动态创建一个 div，并追加到 body 中
  if (!consoleDiv) {
    consoleDiv = document.createElement("div");
    consoleDiv.id = "custom-console";
    document.body.appendChild(consoleDiv);
  }
  // 设置容器为相对定位，方便内部绝对定位的背景元素正确定位
  consoleDiv.style.position = "relative";

  // 检查是否存在背景 "LOG" 元素（class 为 "console-bg"）
  let bgElem = consoleDiv.querySelector(".console-bg") as HTMLElement | null;
  if (!bgElem) {
    // 如果没有找到，则创建背景 "LOG" 元素
    bgElem = document.createElement("div");
    bgElem.className = "console-bg";
    bgElem.textContent = "LOG";
    // 设置背景 "LOG" 的样式：绝对定位、铺满容器、居中显示，字体大小 100px、加粗、颜色全白（后续根据日志行数调整透明度）
    Object.assign(bgElem.style, {
      position: "absolute",
      top: "0",
      left: "0",
      width: "100%",
      height: "100%",
      display: "flex",
      justifyContent: "center",
      alignItems: "center",
      fontSize: "150px",
      fontWeight: "bold",
      color: "rgba(255, 255, 255, 1)",
      pointerEvents: "none", // 禁止鼠标事件，确保不会影响交互
      zIndex: "0"         // 背景放在最底层
    });
    // 将背景 "LOG" 插入到容器最前面
    consoleDiv.insertBefore(bgElem, consoleDiv.firstChild);
  }

  /**
   * updateLinesDisplay - 更新日志行显示及背景 "LOG" 透明度
   *   - 如果日志行数超过 10 行，则背景 "LOG" 完全透明；
   *   - 否则背景 "LOG" 的透明度为 (10 - 当前日志行数) / 10。
   * 同时更新日志行的显示样式，确保日志内容显示在背景之上。
   */
  function updateLinesDisplay() {
    // 过滤出不含背景元素的所有日志行
    const logLines = Array.from(consoleDiv!.children).filter(child => !child.classList.contains("console-bg"));
    const count = logLines.length;
    // 计算背景 "LOG" 的透明度：
    // 默认 80%（0.8），每增加一行降低 (0.8 / 10)，当日志行数达到 10 行时透明度降为 0
    let bgOpacity = Math.max(0.07, 0.4 - (0.5 / 10) * count);
    bgElem!.style.color = `rgba(255, 255, 255, ${bgOpacity})`;

    // 更新每一行日志的样式：如果日志行数超过 9 行，前两行半透明，其余正常显示
    for (let i = 0; i < logLines.length; i++) {
      const line = logLines[i] as HTMLElement;
      if (count > 9) {
        line.style.opacity = i < 2 ? '0.5' : '1';
      } else {
        line.style.opacity = '1';
      }
      line.style.display = 'block';
      // 确保日志行显示在背景 "LOG" 之上
      line.style.position = "relative";
      line.style.zIndex = "1";
    }
  }


  /**
   * writeToConsole - 将日志写入自定义容器
   * @param type 日志类型 ("log" | "error" | "warn")
   * @param args 日志内容参数（多个参数合并为一行文本）
   */
  function writeToConsole(type: "log" | "error" | "warn", ...args: any[]) {
    // 创建一个新的 div 作为一行日志
    const line = document.createElement("div");
    // 保持换行显示
    line.style.whiteSpace = "pre-wrap";
    // 添加下边距，使各行间隔清晰
    line.style.marginBottom = "4px";
    // 构造日志文本，格式为 "[TYPE] " + 内容
    line.textContent = `[${type.toUpperCase()}] ` + args.join(" ");
    // 根据日志类型设置颜色
    if (type === "error") {
      line.style.color = "red";
    } else if (type === "warn") {
      line.style.color = "orange";
    }
    // 将日志行追加到自定义容器中
    consoleDiv!.appendChild(line);

    // 当日志行数超过 13 行时，移除最早的一行
    const logLines = Array.from(consoleDiv!.children).filter(child => !child.classList.contains("console-bg"));
    if (logLines.length > 13) {
      consoleDiv!.removeChild(logLines[0]);
    }
    // 自动滚动到容器底部
    consoleDiv!.scrollTop = consoleDiv!.scrollHeight;
    // 更新日志行样式和背景透明度
    updateLinesDisplay();
  }

  // 重写 console.log 方法
  console.log = function(...args: any[]) {
    originalLog.apply(console, args);
    writeToConsole("log", ...args);
  };

  // 重写 console.error 方法
  console.error = function(...args: any[]) {
    originalError.apply(console, args);
    writeToConsole("error", ...args);
  };

  // 重写 console.warn 方法
  console.warn = function(...args: any[]) {
    originalWarn.apply(console, args);
    writeToConsole("warn", ...args);
  };
}

// 在组件挂载时调用 overrideConsole 函数
onMounted(() => {
  overrideConsole();
});
</script>

<style scoped>
/* 自定义日志输出容器样式 */
.custom-console {
  position: fixed;               /* 固定定位在页面中 */
  bottom: 10px;                  /* 距离底部 10px */
  right: 10px;                   /* 距离右侧 10px */
  width: 600px;                  /* 宽度 600px */
  height: 350px;                 /* 固定高度 350px */
  overflow-y: auto;              /* 垂直方向滚动 */
  background-color: #222;        /* 背景颜色深灰 */
  color: #ddd;                   /* 默认字体颜色 */
  padding: 10px;                 /* 内边距 10px */
  font-family: monospace;        /* 使用等宽字体 */
  font-size: 20px;               /* 字体大小 20px */
  border: 1px solid #444;        /* 边框颜色 */
  border-radius: 4px;            /* 圆角边框 */
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.4);  /* 阴影效果 */
  z-index: 1000;                 /* 保证高层显示 */
  text-align: left;              /* 日志内容左对齐 */
  font-weight: bold;             /* 日志字体加粗 */
}
</style>
