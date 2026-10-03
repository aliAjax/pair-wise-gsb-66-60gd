<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import MileageCanvas from '../components/MileageCanvas.vue'
import { useTrackStore } from '../stores/track'
import type { SpeedRestorationRequest } from '../types'

const store = useTrackStore()
const speed = ref(store.selectedSegment?.speedLimit ?? 160)
const temporary = ref<number | undefined>(store.selectedSegment?.temporarySpeedLimit)
const message = ref('')
const restoreMessage = ref('')
const dispatchers = ['调度员 方林', '调度员 陈洁']
const operators = reactive<Record<string, string>>({})
const segmentDefects = computed(() => store.defects.filter((item) => item.segmentId === store.selectedSegmentId))
const segmentRestorations = computed(() => store.restorations.filter((item) => item.segmentId === store.selectedSegmentId))
function saveSpeed() {
  const result = store.updateSegmentSpeed(store.selectedSegmentId, speed.value, temporary.value)
  message.value = result.message
}
function decide(request: SpeedRestorationRequest, approve: boolean) {
  const operator = operators[request.id] || dispatchers[0]
  // 批次号按申请+调度员确定：同一人重复提交幂等，两人同时提交则后到者保留冲突
  const result = store.decideRestoration(request.id, approve, operator, request.version, `SUB-${request.id}-${operator}`)
  restoreMessage.value = result.message
}
function simulateFailure() {
  store.failNextWriteOnce()
  restoreMessage.value = '已设置：下一次写入将失败，用于验证批次回滚与恢复'
}
function recover() {
  restoreMessage.value = store.recoverPendingBatches().message
}
function statusColor(status: string) {
  return status === '待复核' ? 'warning' : status === '已恢复' ? 'success' : status === '已驳回' ? 'default' : 'error'
}
</script>

<template>
  <section class="page">
    <div class="split">
      <div class="segment-list">
        <button v-for="segment in store.segments" :key="segment.id" :class="{ active: segment.id === store.selectedSegmentId }" @click="store.selectedSegmentId = segment.id; speed = segment.speedLimit; temporary = segment.temporarySpeedLimit">
          <span>{{ segment.id }} · V{{ segment.version }}</span><strong>{{ segment.line }}</strong><small>K{{ Math.floor(segment.startMileage / 1000) }}+{{ String(segment.startMileage % 1000).padStart(3, '0') }} - K{{ Math.floor(segment.endMileage / 1000) }}+{{ String(segment.endMileage % 1000).padStart(3, '0') }}</small>
        </button>
      </div>
      <div v-if="store.selectedSegment" class="track-main">
        <div class="section-head"><div><span>{{ store.selectedSegment.id }}</span><h2>{{ store.selectedSegment.line }}</h2><p>正式限速 {{ store.selectedSegment.speedLimit }} km/h<template v-if="store.selectedSegment.temporarySpeedLimit"> · 临时限速 {{ store.selectedSegment.temporarySpeedLimit }} km/h</template></p></div><v-chip color="warning">区段版本 V{{ store.selectedSegment.version }}</v-chip></div>
        <MileageCanvas :segment="store.selectedSegment" :defects="segmentDefects" />
        <div class="speed-panel">
          <div><strong>速度与限速联查</strong><p>一级缺陷未关闭时，临时限速必须低于正式限速；保存后区段版本递增。</p></div>
          <v-text-field v-model.number="speed" label="正式限速" suffix="km/h" density="compact" variant="outlined" hide-details />
          <v-text-field v-model.number="temporary" label="临时限速" suffix="km/h" density="compact" variant="outlined" hide-details clearable />
          <v-btn color="primary" @click="saveSpeed">保存速度版本</v-btn>
        </div>
        <div v-if="message" class="validation-message">{{ message }}</div>
        <div class="restoration-panel">
          <div class="restoration-head">
            <div><strong>限速恢复复核</strong><p>一级缺陷清零后自动生成待复核申请，复核期间临时限速保持；复核期内再出现未关闭一级缺陷或复测结论更新，申请立即作废并重新计算。可开两个窗口模拟两名调度员同时提交：先到者生效，后到者保留冲突。</p></div>
            <div class="restoration-tools">
              <v-btn size="small" variant="text" @click="simulateFailure">模拟下次写入失败</v-btn>
              <v-btn v-if="store.pendingBatches.length" size="small" color="warning" @click="recover">恢复批次({{ store.pendingBatches.length }})</v-btn>
            </div>
          </div>
          <div v-if="!segmentRestorations.length" class="restoration-empty">当前区段暂无限速恢复申请；一级缺陷清零且挂有临时限速时自动生成。</div>
          <div v-for="request in segmentRestorations" :key="request.id" class="restoration-item">
            <div class="restoration-title">
              <v-chip size="small" :color="statusColor(request.status)">{{ request.status }}</v-chip>
              <strong>{{ request.id }}</strong>
              <span>V{{ request.version }}</span>
              <small>保持临时限速 {{ request.keptTemporarySpeedLimit }} km/h → 恢复 {{ request.restoreSpeedLimit }} km/h</small>
            </div>
            <small class="restoration-meta">触发：{{ request.trigger }} · 创建于 {{ request.createdAt.replace('T', ' ').slice(0, 16) }}<template v-if="request.decidedAt"> · 复核：{{ request.decidedBy }} {{ request.decidedAt.replace('T', ' ').slice(0, 16) }}</template></small>
            <small v-if="request.voidReason" class="restoration-meta void">作废原因：{{ request.voidReason }}</small>
            <div v-if="request.status === '待复核'" class="decide-bar">
              <v-select v-model="operators[request.id]" :items="dispatchers" label="复核调度员" density="compact" variant="outlined" hide-details />
              <v-btn size="small" color="primary" @click="decide(request, true)">确认恢复限速</v-btn>
              <v-btn size="small" variant="outlined" @click="decide(request, false)">驳回申请</v-btn>
              <span>提交版本 V{{ request.version }}</span>
            </div>
            <div v-if="request.conflicts.length" class="conflict-list">
              <div v-for="(conflict, index) in request.conflicts" :key="index">冲突留痕：{{ conflict.operator }}提交「{{ conflict.decision }}」时期望版本V{{ conflict.expectedVersion }}，当前V{{ conflict.currentVersion }}，未生效（{{ conflict.attemptedAt.replace('T', ' ').slice(0, 16) }}）</div>
            </div>
          </div>
          <div v-if="restoreMessage" class="validation-message">{{ restoreMessage }}</div>
        </div>
        <v-table density="compact">
          <thead><tr><th>关联缺陷</th><th>里程</th><th>类型</th><th>严重度</th><th>状态</th></tr></thead>
          <tbody><tr v-for="item in segmentDefects" :key="item.id"><td>{{ item.id }}</td><td>K{{ Math.floor(item.mileage / 1000) }}+{{ String(item.mileage % 1000).padStart(3, '0') }}</td><td>{{ item.type }}</td><td>{{ item.severity }}</td><td>{{ item.status }}</td></tr></tbody>
        </v-table>
      </div>
    </div>
  </section>
</template>

<style scoped>
.split { display: grid; grid-template-columns: 300px 1fr; gap: 14px; align-items: start; }
.segment-list { display: grid; gap: 8px; }
.segment-list button { background: white; border: 1px solid #dae1e2; padding: 13px; text-align: left; display: grid; gap: 6px; cursor: pointer; border-radius: 4px; }
.segment-list button.active { border-color: #315b72; box-shadow: inset 3px 0 #315b72; }
.segment-list span, .segment-list small { color: #748180; font-size: 11px; }
.track-main { background: white; border: 1px solid #dae1e2; padding: 18px; }
.section-head { display: flex; justify-content: space-between; margin-bottom: 14px; }
.section-head span { color: #738180; font-size: 11px; }.section-head h2 { margin: 4px 0; font-size: 20px; }.section-head p { margin: 0; color: #60706f; }
.speed-panel { display: grid; grid-template-columns: 1fr 130px 130px auto; gap: 10px; align-items: center; margin: 14px 0; padding: 12px; background: #f4f7f7; }
.speed-panel p { margin: 4px 0 0; color: #71807f; font-size: 11px; }
.validation-message { color: #a33a35; font-size: 12px; margin-bottom: 10px; }
.restoration-panel { border: 1px solid #e0d9c4; background: #fbf9f1; padding: 12px; margin-bottom: 14px; display: grid; gap: 10px; }
.restoration-head { display: flex; justify-content: space-between; gap: 12px; }
.restoration-head p { margin: 4px 0 0; color: #736d5b; font-size: 11px; }
.restoration-tools { display: flex; gap: 6px; align-items: start; white-space: nowrap; }
.restoration-empty { color: #8a8471; font-size: 12px; }
.restoration-item { border-top: 1px solid #e7e0cd; padding-top: 10px; display: grid; gap: 6px; }
.restoration-title { display: flex; align-items: center; gap: 8px; }
.restoration-title span { color: #748180; font-size: 11px; }
.restoration-title small { color: #60706f; }
.restoration-meta { color: #74807e; font-size: 11px; }
.restoration-meta.void { color: #a33a35; }
.decide-bar { display: grid; grid-template-columns: 180px auto auto 1fr; gap: 8px; align-items: center; }
.decide-bar span { color: #748180; font-size: 11px; }
.conflict-list { border-left: 3px solid #b84239; background: #faf0ef; padding: 8px 10px; display: grid; gap: 4px; color: #8a3531; font-size: 11px; }
</style>
