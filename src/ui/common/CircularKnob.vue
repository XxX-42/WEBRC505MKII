<template>
  <!-- 绑定缩放样式和鼠标滚轮事件 -->
  <div
      class="knob-container"
      :style="{ transform: `scale(${scale})` }"
      @wheel="handleWheel"
  >
    <!-- SVG 容器，设置宽高，并绑定鼠标按下事件 -->
    <svg
        :width="size"
        :height="size"
        @mousedown="startDrag"
    >
      <!-- 灰色背景环，表示整个圆形轨道 -->
      <circle
          :cx="size / 2"
          :cy="size / 2"
          :r="radius"
          stroke="#d3d3d3"
          :stroke-width="strokeWidth"
          fill="none"
      />
      <!-- 蓝色进度环，表示当前进度，从 7 点钟方向（210°）开始 -->
      <circle
          class="progress-circle"
          :cx="size / 2"
          :cy="size / 2"
          :r="radius"
          stroke="#007bff"
          :stroke-width="strokeWidth"
          fill="none"
          :stroke-dasharray="circumference"
          :stroke-dashoffset="dashOffset"
          :transform="`rotate(120, ${size / 2}, ${size / 2})`"
      />
      <!-- 白色中心圆，用于覆盖内部区域，美化外观 -->
      <circle
          :cx="size / 2"
          :cy="size / 2"
          :r="radius - strokeWidth / 2"
          fill="white"
      />
      <!-- 中心文字，显示当前值 -->
      <text
          :x="size / 2"
          :y="size / 2"
          text-anchor="middle"
          dominant-baseline="middle"
          font-size="40"
          font-weight="bold"
          fill="black"
      >
        {{ value }}
      </text>
    </svg>
  </div>
</template>

<script>
import { ref, computed } from 'vue';

export default {
  name: 'CircularKnob',
  props: {
    min: { type: Number, default: 0 }, // 最小值
    max: { type: Number, default: 100 }, // 最大值
    initialValue: { type: Number, default: 50 }, // 初始值
    size: { type: Number, default: 200 }, // SVG 尺寸
    sensitivity: { type: Number, default: 0.3 }, // 灵敏度，控制值变化速度
  },
  setup(props) {
    // 定义响应式值
    const value = ref(props.initialValue);
    // 定义整体缩放比例，默认1
    const scale = ref(0.5);
    // 缩放范围和灵敏度

    const scaleSensitivity = 0.001; // 根据鼠标滚轮变化量调整缩放

    // 计算进度环的 stroke-dashoffset
    const strokeWidth = 35; // 圆环宽度
    const radius = (props.size - strokeWidth) / 2; // 圆环半径
    const circumference = 2 * Math.PI * radius; // 圆周长
    const dashOffset = computed(() => {
      // 计算当前值在 min 到 max 范围内的进度比例
      const progress = (value.value - props.min) / (props.max - props.min);
      // 活动范围为 300°，计算对应的弧长
      const arcLength = progress * (300 / 360) * circumference;
      // 返回 dashOffset，用于控制进度环的显示
      return circumference - arcLength;
    });

    // 开始拖动
    const startDrag = (event) => {
      const startY = event.clientY; // 记录初始 Y 坐标
      const startValue = value.value; // 记录初始值

      // 拖动中
      const onDrag = (event) => {
        const deltaY = startY - event.clientY; // 计算 Y 轴变化量（向上为正）
        const deltaValue = deltaY * props.sensitivity; // 根据灵敏度计算值变化
        let newValue = startValue + deltaValue; // 计算新值
        // 限制值在 min 和 max 之间
        newValue = Math.max(props.min, Math.min(props.max, newValue));
        value.value = Math.round(newValue); // 更新值并四舍五入
      };

      // 停止拖动
      const stopDrag = () => {
        // 移除全局事件监听器
        document.removeEventListener('mousemove', onDrag);
        document.removeEventListener('mouseup', stopDrag);
      };

      // 绑定全局 mousemove 和 mouseup 事件，确保拖动不中断
      document.addEventListener('mousemove', onDrag);
      document.addEventListener('mouseup', stopDrag);
    };

// 鼠标调整该旋钮的 value
    const handleWheel = (event) => {
      event.preventDefault(); // 阻止页面滚动
      if (event.shiftKey) {
        // 当按下 shift 键时，使用较高灵敏度 0.05
        const wheelSensitivity = 0.05;
        let newValue = value.value - event.deltaY * wheelSensitivity;
        // 限制 newValue 在 min 和 max 之间
        newValue = Math.max(props.min, Math.min(props.max, newValue));
        // 四舍五入到最近的10的整数倍
        newValue = Math.round(newValue / 10) * 10;
        value.value = newValue;
      } else {
        // 默认滚轮灵敏度为 0.003
        const wheelSensitivity = 0.003;
        let newValue = value.value - event.deltaY * wheelSensitivity;
        newValue = Math.max(props.min, Math.min(props.max, newValue));
        value.value = Math.round(newValue);
      }
    };




    // 返回响应式数据和方法
    return {
      value,
      scale,
      strokeWidth,
      radius,
      circumference,
      dashOffset,
      startDrag,
      handleWheel,
    };
  },
};
</script>

<style scoped>
.knob-container {
  display: inline-block;
  user-select: none; /* 防止拖动时选中文字 */
  justify-content: center;
  width: 170px;
  height: 170px;
}

.progress-circle {
  transition: stroke-dashoffset 0.3s ease; /* 添加平滑过渡效果 */
}
</style>
