<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { useRoute } from 'vue-router'
import { useTrackStore } from '../stores/track'

const route = useRoute()
const store = useTrackStore()
const selectedId = ref(String(route.params.id || store.defects[0]?.id || ''))
const defect = computed(() => store.defects.find((item) => item.id === selectedId.value))
const action = reactive({ method: '捣固', note: '', operator: '李海' })
const retest = reactive({ measuredValue: 0, tester: '王磊', note: '' })
const correction = reactive({ measuredValue: 0, tester: '王磊', note: '' })
const message = ref('')
const messageType = ref<'info' | 'error' | 'success'>('info')

function report(result: { ok: boolean; conflict?: boolean; message: string }) {
  message.value = result.message
  messageType.value = result.conflict ? 'error' : result.ok ? 'success' : 'error'
}

function addAction() {
  if (!defect.value || !action.note) return
  const result = store.addAction(defect.value.id, { ...action, method: action.method as any, recordedAt: new Date().toISOString() })
  report(result.results[0] ?? result)
  if (result.ok) action.note = ''
}

/** 提交时携带缺陷当前版本（乐观锁）：两名调度员同时提交，只有先到者生效 */
function addRetest() {
  if (!defect.value) return
  const round = defect.value.retests.length + 1
  const passed = retest.measuredValue <= defect.value.limit
  const expectedVersion = defect.value.version
  const result = store.addRetest(defect.value.id, { round, passed, measuredValue: retest.measuredValue, limit: defect.value.limit, note: retest.note || (passed ? '复测合格' : '仍超过限值'), tester: retest.tester, testedAt: new Date().toISOString() }, expectedVersion)
  const first = result.results[0] ?? result
  report(first)
  if (first.ok) message.value = passed ? '复测通过，缺陷已关闭；临时限速保持，限速恢复申请待调度复核' : first.message
}

/** 晚到的复测更正：覆盖最近一轮结论并留痕，在途恢复申请立即作废重算 */
function correctRetest() {
  if (!defect.value) return
  const result = store.correctRetestResult(defect.value.id, { measuredValue: correction.measuredValue, tester: correction.tester, note: correction.note || '晚到复测更正' })
  report(result.results[0] ?? result)
}

function closeDefect() {
  if (!defect.value) return
  report(store.transition(defect.value.id, '已关闭'))
}

const segmentPending = computed(() => (defect.value ? store.pendingRecoveryFor(defect.value.segmentId) : undefined))
</script>

<template>
  <section class="page">
    <div class="work-layout">
      <div class="work-list">
        <button v-for="item in store.defects" :key="item.id" :class="{ active: item.id === selectedId }" @click="selectedId = item.id">
          <span>{{ item.id }} · V{{ item.version }}</span><strong>{{ item.type }}超限</strong><small>{{ item.owner }} · {{ item.status }}</small>
        </button>
      </div>
      <div v-if="defect" class="work-main">
        <div class="section-head"><div><span>{{ defect.segmentId }} · K{{ Math.floor(defect.mileage / 1000) }}+{{ String(defect.mileage % 1000).padStart(3, '0') }}</span><h2>{{ defect.type }}缺陷整治</h2><p>{{ defect.measuredValue }} / 限值 {{ defect.limit }} · {{ defect.severity }} · {{ defect.status }}</p></div><v-chip :color="defect.status === '已关闭' ? 'success' : 'warning'">{{ defect.status }}</v-chip></div>
        <div v-if="segmentPending" class="recovery-band">
          <strong>限速恢复申请 {{ segmentPending.id }} 待复核</strong>
          <span>临时限速 {{ segmentPending.heldTemporarySpeedLimit ?? '无' }} km/h 暂保持；复核期间若出现新一级缺陷或复测结论更新，申请自动作废重算。</span>
        </div>
        <div class="offline-band"><strong>离线补录模式</strong><span>现场无网络时先写入本地批次队列，恢复后保留原始记录时间和复测轮次；重复提交不会多出限速记录。</span></div>
        <div class="action-form">
          <v-select v-model="action.method" :items="['打磨', '捣固', '更换', '垫板调整', '测量复核']" label="整治方式" density="compact" variant="outlined" hide-details />
          <v-text-field v-model="action.note" label="现场记录" density="compact" variant="outlined" hide-details />
          <v-text-field v-model="action.operator" label="操作人" density="compact" variant="outlined" hide-details />
          <v-btn color="primary" :disabled="!action.note" @click="addAction">提交整治记录</v-btn>
        </div>
        <div class="action-form">
          <v-text-field v-model.number="retest.measuredValue" type="number" label="复测值" density="compact" variant="outlined" hide-details />
          <v-text-field v-model="retest.tester" label="复测人" density="compact" variant="outlined" hide-details />
          <v-text-field v-model="retest.note" label="复测说明" density="compact" variant="outlined" hide-details />
          <v-btn color="secondary" @click="addRetest">提交复测（基于V{{ defect.version }}）</v-btn>
        </div>
        <div class="action-form correction">
          <v-text-field v-model.number="correction.measuredValue" type="number" label="更正复测值" density="compact" variant="outlined" hide-details />
          <v-text-field v-model="correction.tester" label="复测人" density="compact" variant="outlined" hide-details />
          <v-text-field v-model="correction.note" label="更正说明（晚到结论）" density="compact" variant="outlined" hide-details />
          <v-btn variant="outlined" :disabled="!defect.retests.length" @click="correctRetest">复测结论更正并重算</v-btn>
        </div>
        <div v-if="message" class="validation-message" :class="messageType">{{ message }}</div>
        <div class="two-column">
          <div><h3>整治记录</h3><div v-for="item in defect.actions" :key="item.recordedAt" class="record-item"><strong>{{ item.method }}</strong><span>{{ item.note }}</span><small>{{ item.operator }} · {{ item.recordedAt.replace('T', ' ').slice(0, 16) }}</small></div></div>
          <div>
            <h3>复测轮次</h3>
            <div v-for="item in defect.retests" :key="item.round" class="record-item" :class="{ corrected: item.corrected }">
              <strong>第{{ item.round }}轮 {{ item.passed ? '通过' : '未通过' }}<v-chip v-if="item.corrected" size="x-small" color="warning" class="corr-chip">已更正</v-chip></strong>
              <span>{{ item.measuredValue }} / {{ item.limit }}</span>
              <small>{{ item.tester }} · {{ item.note }}</small>
              <small v-if="item.correctedFrom" class="corrected-from">原结论：{{ item.correctedFrom.passed ? '通过' : '未通过' }} {{ item.correctedFrom.measuredValue }}（{{ item.correctedFrom.tester }}）</small>
            </div>
          </div>
        </div>
        <v-btn variant="outlined" @click="closeDefect">申请关闭缺陷</v-btn>
      </div>
    </div>
  </section>
</template>

<style scoped>
.work-layout { display: grid; grid-template-columns: 300px 1fr; gap: 14px; align-items: start; }
.work-list { display: grid; gap: 8px; }
.work-list button { border: 1px solid #dae1e2; background: white; padding: 13px; text-align: left; display: grid; gap: 6px; cursor: pointer; }
.work-list button.active { border-color: #315b72; box-shadow: inset 3px 0 #315b72; }
.work-list span, .work-list small { color: #738180; font-size: 11px; }
.work-main { background: white; border: 1px solid #dae1e2; padding: 18px; }
.section-head { display: flex; justify-content: space-between; margin-bottom: 14px; }.section-head span { color: #71807e; font-size: 11px; }.section-head h2 { margin: 4px 0; }.section-head p { margin: 0; color: #667573; }
.recovery-band { display: grid; gap: 3px; padding: 11px; border-left: 3px solid #2f7a4d; background: #eef7f1; font-size: 12px; margin-bottom: 10px; }
.recovery-band span { color: #446551; }
.offline-band { display: flex; justify-content: space-between; padding: 11px; border-left: 3px solid #b08735; background: #fbf6e9; font-size: 12px; }.offline-band span { color: #736d5b; }
.action-form { display: grid; grid-template-columns: 170px 1fr 140px auto; gap: 10px; margin: 13px 0; align-items: center; }
.action-form.correction { border-top: 1px dashed #d4dbda; padding-top: 13px; }
.validation-message { font-size: 12px; margin-bottom: 10px; color: #a33a35; }
.validation-message.success { color: #2f7a4d; }
.two-column { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin: 18px 0; }.two-column h3 { font-size: 14px; }
.record-item { border-top: 1px solid #e2e7e7; padding: 10px 0; display: grid; gap: 4px; }.record-item span, .record-item small { color: #6d7b79; font-size: 11px; }
.record-item.corrected { background: #fdf8ec; padding-left: 8px; padding-right: 8px; border-left: 3px solid #b08735; }
.corr-chip { margin-left: 6px; }
.corrected-from { color: #9a6a2b !important; }
</style>
