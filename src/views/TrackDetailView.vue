<script setup lang="ts">
import { computed, ref } from 'vue'
import MileageCanvas from '../components/MileageCanvas.vue'
import { useTrackStore } from '../stores/track'
import { simulateNextWriteFailure } from '../stores/track'
import type { RecoveryApplication } from '../types'

const store = useTrackStore()
const speed = ref(store.selectedSegment?.speedLimit ?? 160)
const temporary = ref<number | undefined>(store.selectedSegment?.temporarySpeedLimit)
const message = ref('')
const reviewer = ref('方林')
const secondReviewer = ref('赵晨')
const newDefect = reactiveDefect()
const recoverReports = ref<string[]>([])

function reactiveDefect() {
  return { mileage: 103000, type: '轨距' as const, measuredValue: 1448, limit: 1446, owner: '工务一工区' }
}

const segmentDefects = computed(() => store.defects.filter((item) => item.segmentId === store.selectedSegmentId))
const segmentApplications = computed(() => store.recoveryApplications.filter((item) => item.segmentId === store.selectedSegmentId))
const pendingApplication = computed(() => segmentApplications.value.find((item) => item.status === '待复核'))
const segmentConflicts = computed(() => store.conflicts.filter((item) => item.segmentId === store.selectedSegmentId))
const openLevelOne = computed(() => store.defects.filter((item) => item.segmentId === store.selectedSegmentId && item.severity === '一级' && item.status !== '已关闭'))

function saveSpeed() {
  const result = store.updateSegmentSpeed(store.selectedSegmentId, speed.value, temporary.value)
  message.value = result.message
}

/** 调度员复核（携带申请版本做乐观并发）；先到者生效，后到者保留冲突 */
function review(application: RecoveryApplication, approve: boolean, who: string) {
  const result = store.reviewRecoveryApplication(application.id, approve, who, application.version)
  message.value = (result.results[0] ?? result).message
}

/** 模拟两名调度员同时提交复核：仅先到者生效 */
function simultaneousReview(application: RecoveryApplication) {
  const first = store.reviewRecoveryApplication(application.id, true, reviewer.value, application.version)
  const second = store.reviewRecoveryApplication(application.id, true, secondReviewer.value, application.version)
  message.value = `先到（${reviewer.value}）：${(first.results[0] ?? first).message} ｜ 后到（${secondReviewer.value}）：${(second.results[0] ?? second).message}`
}

function registerDefect() {
  const result = store.registerLevelOneDefect({ segmentId: store.selectedSegmentId, ...newDefect })
  message.value = (result.results[0] ?? result).message
}

function failWriteThenRecover() {
  simulateNextWriteFailure()
  // 触发一个批次，其写入会失败并自动从完整批次快照回滚
  const failed = store.updateSegmentSpeed(store.selectedSegmentId, speed.value, temporary.value)
  const reports = store.recoverPending()
  recoverReports.value = [failed.message, ...reports.map((item) => `恢复批次${item.batchId}：${item.message}`)]
  message.value = failed.message
}

function selectSegment(id: string) {
  store.selectedSegmentId = id
  const segment = store.segments.find((item) => item.id === id)
  speed.value = segment?.speedLimit ?? 160
  temporary.value = segment?.temporarySpeedLimit
  message.value = ''
  recoverReports.value = []
}
</script>

<template>
  <section class="page">
    <div class="split">
      <div class="segment-list">
        <button v-for="segment in store.segments" :key="segment.id" :class="{ active: segment.id === store.selectedSegmentId }" @click="selectSegment(segment.id)">
          <span>{{ segment.id }} · V{{ segment.version }}</span><strong>{{ segment.line }}</strong><small>K{{ Math.floor(segment.startMileage / 1000) }}+{{ String(segment.startMileage % 1000).padStart(3, '0') }} - K{{ Math.floor(segment.endMileage / 1000) }}+{{ String(segment.endMileage % 1000).padStart(3, '0') }}</small>
        </button>
      </div>
      <div v-if="store.selectedSegment" class="track-main">
        <div class="section-head"><div><span>{{ store.selectedSegment.id }}</span><h2>{{ store.selectedSegment.line }}</h2><p>正式限速 {{ store.selectedSegment.speedLimit }} km/h<template v-if="store.selectedSegment.temporarySpeedLimit"> · 临时限速 {{ store.selectedSegment.temporarySpeedLimit }} km/h（保持中）</template></p></div><v-chip color="warning">区段版本 V{{ store.selectedSegment.version }}</v-chip></div>
        <MileageCanvas :segment="store.selectedSegment" :defects="segmentDefects" />

        <div v-if="pendingApplication" class="review-panel">
          <div class="review-head">
            <div><strong>限速恢复申请 {{ pendingApplication.id }} · V{{ pendingApplication.version }} · 待复核</strong><p>清零缺陷：{{ pendingApplication.basis.closedLevelOneDefectIds.join('、') }}；临时限速 {{ pendingApplication.heldTemporarySpeedLimit ?? '无' }} km/h 暂保持，待调度确认后方可解除。</p></div>
            <v-chip color="warning">临时限速保持</v-chip>
          </div>
          <div class="review-actions">
            <v-text-field v-model="reviewer" label="调度员甲" density="compact" variant="outlined" hide-details style="max-width: 130px" />
            <v-btn color="success" @click="review(pendingApplication, true, reviewer)">甲：复核通过（解除临时限速）</v-btn>
            <v-btn color="error" variant="outlined" @click="review(pendingApplication, false, reviewer)">甲：驳回（继续保持）</v-btn>
            <v-text-field v-model="secondReviewer" label="调度员乙" density="compact" variant="outlined" hide-details style="max-width: 130px" />
            <v-btn color="secondary" variant="tonal" @click="simultaneousReview(pendingApplication)">模拟两人同时提交（只先到者生效）</v-btn>
          </div>
        </div>
        <div v-else-if="openLevelOne.length" class="review-panel blocked">
          <strong>仍有 {{ openLevelOne.length }} 项未关闭一级缺陷</strong>
          <span>{{ openLevelOne.map((item) => item.id).join('、') }}；临时限速必须维持并低于正式限速，待全部关闭后自动生成恢复申请。</span>
        </div>

        <div class="speed-panel">
          <div><strong>速度与限速联查</strong><p>一级缺陷未关闭时，临时限速必须低于正式限速；清零后临时限速不会立刻恢复，须经复核。保存后区段版本递增。</p></div>
          <v-text-field v-model.number="speed" label="正式限速" suffix="km/h" density="compact" variant="outlined" hide-details />
          <v-text-field v-model.number="temporary" label="临时限速" suffix="km/h" density="compact" variant="outlined" hide-details clearable />
          <v-btn color="primary" @click="saveSpeed">保存速度版本</v-btn>
        </div>

        <div class="speed-panel register">
          <div><strong>登记新发现一级缺陷</strong><p>复核期间登记后，待复核申请立即作废并重新计算。</p></div>
          <v-text-field v-model.number="newDefect.mileage" type="number" label="里程" density="compact" variant="outlined" hide-details />
          <v-select v-model="newDefect.type" :items="['轨距', '高低', '方向', '三角坑']" label="类型" density="compact" variant="outlined" hide-details />
          <v-text-field v-model.number="newDefect.measuredValue" type="number" label="实测值" density="compact" variant="outlined" hide-details />
          <v-text-field v-model.number="newDefect.limit" type="number" label="限值" density="compact" variant="outlined" hide-details />
          <v-btn color="error" variant="outlined" @click="registerDefect">登记一级缺陷</v-btn>
        </div>

        <div class="speed-panel recovery-demo">
          <div><strong>写入失败与批次恢复演练</strong><p>模拟下一次持久化写入失败：批次从完整快照回滚，再从日志恢复并接着处理；重复提交不会多出限速记录。</p></div>
          <v-btn variant="tonal" @click="failWriteThenRecover">模拟写入失败 → 从批次恢复</v-btn>
          <div v-for="(line, index) in recoverReports" :key="index" class="recover-line">{{ line }}</div>
        </div>

        <div v-if="message" class="validation-message">{{ message }}</div>

        <div v-if="segmentApplications.length" class="history-block">
          <h3>限速恢复申请记录</h3>
          <v-table density="compact">
            <thead><tr><th>申请</th><th>状态</th><th>依据缺陷</th><th>保持临时限速</th><th>说明</th><th>提出/复核</th></tr></thead>
            <tbody>
              <tr v-for="item in segmentApplications" :key="item.id">
                <td>{{ item.id }} · V{{ item.version }}</td>
                <td><v-chip size="small" :color="item.status === '已生效' ? 'success' : item.status === '已作废' ? 'error' : 'warning'">{{ item.status }}</v-chip></td>
                <td>{{ item.basis.closedLevelOneDefectIds.join('、') }}</td>
                <td>{{ item.heldTemporarySpeedLimit ?? '无' }} km/h</td>
                <td>{{ item.reason ?? '等待复核' }}</td>
                <td>{{ item.createdBy }}<template v-if="item.reviewedBy"> / {{ item.reviewedBy }}</template></td>
              </tr>
            </tbody>
          </v-table>
        </div>

        <div v-if="segmentConflicts.length" class="history-block">
          <h3>并发处理冲突（后到者保留）</h3>
          <v-table density="compact">
            <thead><tr><th>冲突</th><th>详情</th><th>期望版本/实际版本</th><th>处理</th></tr></thead>
            <tbody>
              <tr v-for="item in segmentConflicts" :key="item.id">
                <td>{{ item.id }}</td>
                <td>{{ item.detail }}</td>
                <td>V{{ item.expectedVersion }} / V{{ item.actualVersion }}</td>
                <td>
                  <v-chip size="small" :color="item.resolved ? 'success' : 'error'">{{ item.resolved ? '已处理' : '待处理' }}</v-chip>
                  <v-btn v-if="!item.resolved" size="x-small" variant="text" @click="store.resolveConflict(item.id)">确认以先到者为准</v-btn>
                </td>
              </tr>
            </tbody>
          </v-table>
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
.review-panel { border: 1px solid #bcd4c4; background: #f1f8f4; padding: 13px; margin: 12px 0; display: grid; gap: 10px; }
.review-panel.blocked { border-color: #d9b3a0; background: #fcf1eb; }
.review-panel.blocked span { color: #8a5240; font-size: 12px; }
.review-head { display: flex; justify-content: space-between; align-items: start; gap: 10px; }
.review-head p { margin: 4px 0 0; color: #446551; font-size: 12px; }
.review-actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.speed-panel { display: grid; grid-template-columns: 1fr 130px 130px auto; gap: 10px; align-items: center; margin: 14px 0; padding: 12px; background: #f4f7f7; }
.speed-panel.register { grid-template-columns: 1.4fr 110px 110px 110px 100px auto; }
.speed-panel.recovery-demo { grid-template-columns: 1.6fr auto; }
.speed-panel p { margin: 4px 0 0; color: #71807f; font-size: 11px; }
.recover-line { grid-column: 1 / -1; font-size: 11px; color: #8a5240; }
.validation-message { color: #a33a35; font-size: 12px; margin-bottom: 10px; }
.history-block { margin: 16px 0; }.history-block h3 { font-size: 14px; margin-bottom: 8px; }
</style>
