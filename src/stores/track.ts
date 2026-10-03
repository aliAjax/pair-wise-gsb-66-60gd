import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { seedAudit, seedDefects, seedRestorations, seedSegments } from '../data/seed'
import type { AuditEntry, BatchJournalEntry, Defect, DefectStatus, PersistedState, RectificationAction, RetestResult, SpeedRestorationRequest, TrackSegment } from '../types'

const STORAGE_KEY = 'gsb66:track-geometry'
const JOURNAL_KEY = 'gsb66:track-journal'
let idSeed = 10

export interface BatchOutcome {
  ok: boolean
  message: string
  conflict?: boolean
  duplicate?: boolean
  failed?: boolean
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value))

function seedState(): PersistedState {
  return { stateVersion: 0, segments: clone(seedSegments), defects: clone(seedDefects), audit: clone(seedAudit), restorations: clone(seedRestorations), appliedBatches: [] }
}

function load(): PersistedState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return seedState()
    const parsed = JSON.parse(raw)
    return {
      stateVersion: typeof parsed.stateVersion === 'number' ? parsed.stateVersion : 0,
      segments: parsed.segments ?? clone(seedSegments),
      defects: parsed.defects ?? clone(seedDefects),
      audit: parsed.audit ?? clone(seedAudit),
      restorations: parsed.restorations ?? [],
      appliedBatches: parsed.appliedBatches ?? []
    }
  } catch {
    return seedState()
  }
}

function loadJournal(): BatchJournalEntry[] {
  try {
    const raw = localStorage.getItem(JOURNAL_KEY)
    return raw ? JSON.parse(raw) : []
  } catch {
    return []
  }
}

export const useTrackStore = defineStore('track', () => {
  const initial = load()
  let stateVersion = initial.stateVersion
  let failNextWrite = false
  const segments = ref<TrackSegment[]>(initial.segments)
  const defects = ref<Defect[]>(initial.defects)
  const audit = ref<AuditEntry[]>(initial.audit)
  const restorations = ref<SpeedRestorationRequest[]>(initial.restorations)
  const appliedBatches = ref<string[]>(initial.appliedBatches)
  const journal = ref<BatchJournalEntry[]>(loadJournal())
  const keyword = ref('')
  const status = ref<DefectStatus | '全部'>('全部')
  const selectedSegmentId = ref(segments.value[0]?.id ?? '')

  const filtered = computed(() => defects.value.filter((item) => {
    const segment = segments.value.find((value) => value.id === item.segmentId)
    const text = `${item.id} ${segment?.line ?? ''} ${item.type} ${item.owner}`.toLowerCase()
    return (!keyword.value || text.includes(keyword.value.toLowerCase())) && (status.value === '全部' || item.status === status.value)
  }))

  const selectedSegment = computed(() => segments.value.find((item) => item.id === selectedSegmentId.value))
  const pendingRestorations = computed(() => restorations.value.filter((item) => item.status === '待复核'))
  const pendingBatches = computed(() => journal.value.filter((item) => item.status === '待恢复'))

  function addAudit(entityId: string, action: string, operator: string, detail: string) {
    audit.value.unshift({ id: `A-${Date.now()}-${idSeed++}`, entityId, action, operator, detail, createdAt: new Date().toISOString() })
  }

  // ---------- 批次化持久化：失败回滚、完整批次留存、重复提交幂等 ----------
  function persistMain(payload: PersistedState) {
    if (failNextWrite) {
      failNextWrite = false
      throw new Error('模拟写入失败')
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload))
  }

  function persistJournal() {
    try {
      localStorage.setItem(JOURNAL_KEY, JSON.stringify(journal.value))
    } catch {
      // 批次日志留存失败不影响主流程
    }
  }

  function buildPayload(applied: string[]): PersistedState {
    return { stateVersion: stateVersion + 1, segments: segments.value, defects: defects.value, audit: audit.value, restorations: restorations.value, appliedBatches: applied }
  }

  function capture() {
    return {
      version: stateVersion,
      segments: clone(segments.value),
      defects: clone(defects.value),
      audit: clone(audit.value),
      restorations: clone(restorations.value),
      appliedBatches: clone(appliedBatches.value),
      journal: clone(journal.value)
    }
  }

  function rollback(saved: ReturnType<typeof capture>) {
    segments.value = saved.segments
    defects.value = saved.defects
    audit.value = saved.audit
    restorations.value = saved.restorations
    appliedBatches.value = saved.appliedBatches
    journal.value = saved.journal
    stateVersion = saved.version
  }

  // 其他窗口已提交新批次时先对齐持久化状态，保证并发提交先到者生效
  function adoptPersistedIfNewer() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (!raw) return
      const parsed = JSON.parse(raw)
      const persistedVersion = typeof parsed.stateVersion === 'number' ? parsed.stateVersion : 0
      if (persistedVersion === stateVersion) return
      segments.value = parsed.segments ?? []
      defects.value = parsed.defects ?? []
      audit.value = parsed.audit ?? []
      restorations.value = parsed.restorations ?? []
      appliedBatches.value = parsed.appliedBatches ?? []
      stateVersion = persistedVersion
    } catch {
      // 持久化数据不可读时以内存状态为准
    }
  }

  function commitBatch(batchId: string, mutate: () => BatchOutcome): BatchOutcome {
    adoptPersistedIfNewer()
    if (appliedBatches.value.includes(batchId)) return { ok: true, duplicate: true, message: '重复提交已忽略，未新增限速记录' }
    const saved = capture()
    const outcome = mutate()
    const applied = [...appliedBatches.value, batchId]
    const payload = buildPayload(applied)
    try {
      persistMain(payload)
    } catch {
      rollback(saved)
      journal.value = [...journal.value.filter((item) => item.batchId !== batchId), { batchId, createdAt: new Date().toISOString(), status: '待恢复', payload: clone(payload) }]
      persistJournal()
      return { ok: false, failed: true, message: '写入失败，已回滚到批次前状态；完整批次已留存，可恢复后继续处理' }
    }
    appliedBatches.value = applied
    stateVersion = payload.stateVersion
    journal.value = journal.value.map((item) => (item.batchId === batchId ? { ...item, status: '已提交' as const } : item))
    persistJournal()
    return outcome
  }

  function recoverPendingBatches(): BatchOutcome {
    adoptPersistedIfNewer()
    const pending = journal.value.filter((item) => item.status === '待恢复')
    if (!pending.length) return { ok: false, message: '没有待恢复的批次' }
    const saved = capture()
    try {
      const recovered: string[] = []
      for (const entry of pending) {
        if (appliedBatches.value.includes(entry.batchId)) {
          entry.status = '已提交'
          continue
        }
        segments.value = entry.payload.segments
        defects.value = entry.payload.defects
        audit.value = entry.payload.audit
        restorations.value = entry.payload.restorations
        appliedBatches.value = entry.payload.appliedBatches
        entry.status = '已提交'
        recovered.push(entry.batchId)
        addAudit(entry.batchId, '批次恢复', '系统', '写入失败后从完整批次恢复')
      }
      // 接着处理：按当前缺陷与复测结论重新计算各区段待复核申请
      const notes: string[] = []
      for (const segment of segments.value) notes.push(...ensureApplicationForSegment(segment.id, `B-RECOVER-${Date.now()}`))
      const payload = buildPayload(appliedBatches.value)
      persistMain(payload)
      stateVersion = payload.stateVersion
      persistJournal()
      const suffix = notes.length ? `；${notes.join('；')}` : ''
      return { ok: true, message: `已从完整批次恢复${recovered.length}个批次并继续处理${suffix}` }
    } catch {
      rollback(saved)
      return { ok: false, failed: true, message: '恢复时写入再次失败，完整批次继续留存' }
    }
  }

  function failNextWriteOnce() {
    failNextWrite = true
  }

  // ---------- 限速恢复申请：清零生成待复核申请，复核期作废重算 ----------
  function hasOpenLevel1(segmentId: string) {
    return defects.value.some((item) => item.segmentId === segmentId && item.severity === '一级' && item.status !== '已关闭')
  }

  function ensureApplicationForSegment(segmentId: string, batchId: string): string[] {
    const notes: string[] = []
    const segment = segments.value.find((item) => item.id === segmentId)
    if (!segment || segment.temporarySpeedLimit == null || hasOpenLevel1(segmentId)) return notes
    if (restorations.value.some((item) => item.segmentId === segmentId && item.status === '待复核')) return notes
    const seq = restorations.value.filter((item) => item.segmentId === segmentId).length + 1
    const request: SpeedRestorationRequest = {
      id: `SR-${segmentId}-${seq}`,
      segmentId,
      status: '待复核',
      keptTemporarySpeedLimit: segment.temporarySpeedLimit,
      restoreSpeedLimit: segment.speedLimit,
      trigger: '一级缺陷清零',
      createdAt: new Date().toISOString(),
      version: 1,
      conflicts: [],
      batchId
    }
    restorations.value.unshift(request)
    addAudit(request.id, '生成限速恢复申请', '系统', `${segment.line}一级缺陷清零，临时限速${request.keptTemporarySpeedLimit} km/h保持，待调度复核`)
    notes.push(`已生成待复核申请${request.id}，临时限速${request.keptTemporarySpeedLimit} km/h保持`)
    return notes
  }

  function voidApplicationsForSegment(segmentId: string, reason: string): string[] {
    const notes: string[] = []
    for (const request of restorations.value.filter((item) => item.segmentId === segmentId && item.status === '待复核')) {
      request.status = '已作废'
      request.voidReason = reason
      request.version += 1
      addAudit(request.id, '限速恢复申请作废', '系统', reason)
      notes.push(`申请${request.id}已作废（${reason}）`)
    }
    return notes
  }

  function reconcileSegment(segmentId: string, batchId: string, options: { retestUpdated?: boolean; speedChanged?: boolean; reason: string }): string[] {
    const notes: string[] = []
    if (options.retestUpdated || options.speedChanged || hasOpenLevel1(segmentId)) notes.push(...voidApplicationsForSegment(segmentId, options.reason))
    notes.push(...ensureApplicationForSegment(segmentId, batchId))
    return notes
  }

  // ---------- 缺陷与复测业务动作 ----------
  function assign(defectIds: string[], owner: string) {
    return commitBatch(`B-ASSIGN-${Date.now()}-${idSeed++}`, () => {
      for (const id of defectIds) {
        const defect = defects.value.find((item) => item.id === id)
        if (!defect) continue
        defect.owner = owner
        defect.status = '整治中'
        defect.version += 1
        addAudit(id, '批量派工', '当前用户', `任务分配至${owner}`)
      }
      return { ok: true, message: `已派工${defectIds.length}项至${owner}` }
    })
  }

  function addAction(id: string, action: RectificationAction) {
    const batchId = `B-ACTION-${id}-${Date.now()}-${idSeed++}`
    return commitBatch(batchId, () => {
      const defect = defects.value.find((item) => item.id === id)
      if (!defect) return { ok: false, message: '缺陷不存在' }
      defect.actions.unshift(action)
      defect.status = '待复测'
      defect.version += 1
      addAudit(id, '提交整治记录', action.operator, `${action.method}：${action.note}`)
      const notes = reconcileSegment(defect.segmentId, batchId, { reason: `新增整治记录：${id}` })
      return { ok: true, message: ['整治记录已提交', ...notes].join('；') }
    })
  }

  function addRetest(id: string, retest: RetestResult) {
    const batchId = `B-RETEST-${id}-${retest.round}-${Date.now()}-${idSeed++}`
    return commitBatch(batchId, () => {
      const defect = defects.value.find((item) => item.id === id)
      if (!defect) return { ok: false, message: '缺陷不存在' }
      defect.retests.unshift(retest)
      defect.status = retest.passed ? '已关闭' : '复测不合格'
      defect.version += 1
      addAudit(id, '提交复测', retest.tester, retest.passed ? '复测通过' : `第${retest.round}轮未通过`)
      const base = retest.passed ? '复测通过，缺陷已关闭' : `第${retest.round}轮复测不合格，任务重新进入整治`
      const notes = reconcileSegment(defect.segmentId, batchId, { retestUpdated: true, reason: `复测结论更新：${id}第${retest.round}轮${retest.passed ? '通过' : '未通过'}` })
      return { ok: true, message: [base, ...notes].join('；') }
    })
  }

  function transition(id: string, next: DefectStatus) {
    const batchId = `B-TRANS-${id}-${Date.now()}-${idSeed++}`
    return commitBatch(batchId, () => {
      const defect = defects.value.find((item) => item.id === id)
      if (!defect) return { ok: false, message: '缺陷不存在' }
      if (next === '已关闭' && (!defect.retests.length || !defect.retests.some((item) => item.passed))) return { ok: false, message: '没有合格复测记录，不能关闭' }
      if (next === '待复测' && !defect.actions.length) return { ok: false, message: '缺少整治记录，不能申请复测' }
      const from = defect.status
      defect.status = next
      defect.version += 1
      addAudit(id, `状态流转：${next}`, '当前用户', `由${from}流转至${next}`)
      const notes = reconcileSegment(defect.segmentId, batchId, { reason: `缺陷状态流转：${id}由${from}流转至${next}` })
      return { ok: true, message: [`已流转至${next}`, ...notes].join('；') }
    })
  }

  function updateSegmentSpeed(id: string, speed: number, temporary: number | undefined) {
    const batchId = `B-SPEED-${id}-${Date.now()}-${idSeed++}`
    return commitBatch(batchId, () => {
      const segment = segments.value.find((item) => item.id === id)
      if (!segment) return { ok: false, message: '区段不存在' }
      const conflict = defects.value.some((item) => item.segmentId === id && item.status !== '已关闭' && item.severity === '一级')
      if (conflict && (!temporary || temporary >= speed)) return { ok: false, message: '一级缺陷未关闭时必须设置更低临时限速' }
      segment.speedLimit = speed
      segment.temporarySpeedLimit = temporary
      segment.version += 1
      addAudit(id, '更新区段速度版本', '工务调度', `正式限速${speed} km/h，临时限速${temporary ?? '无'}`)
      const notes = reconcileSegment(id, batchId, { speedChanged: true, reason: '人工调整区段速度版本' })
      return { ok: true, message: ['区段速度版本已更新', ...notes].join('；') }
    })
  }

  // ---------- 复核：先到者生效，后到者保留冲突 ----------
  function decideRestoration(id: string, approve: boolean, operator: string, expectedVersion: number, batchId: string): BatchOutcome {
    return commitBatch(batchId, () => {
      const request = restorations.value.find((item) => item.id === id)
      if (!request) return { ok: false, message: '申请不存在' }
      const decision = approve ? '恢复限速' : '驳回申请'
      if (request.status !== '待复核' || request.version !== expectedVersion) {
        request.conflicts.push({ operator, decision, expectedVersion, currentVersion: request.version, attemptedAt: new Date().toISOString() })
        addAudit(request.id, '复核冲突留痕', operator, `提交「${decision}」时期望版本V${expectedVersion}，当前V${request.version}（${request.status}），结果未生效`)
        return { ok: false, conflict: true, message: `他人已先行处理（当前${request.status}/V${request.version}），本次提交已保留为冲突记录` }
      }
      request.version += 1
      request.decidedAt = new Date().toISOString()
      request.decidedBy = operator
      if (approve) {
        request.status = '已恢复'
        const segment = segments.value.find((item) => item.id === request.segmentId)
        if (segment) {
          segment.temporarySpeedLimit = undefined
          segment.version += 1
          addAudit(segment.id, '取消临时限速', operator, `临时限速${request.keptTemporarySpeedLimit} km/h取消，恢复正式限速${request.restoreSpeedLimit} km/h，区段版本V${segment.version}`)
        }
        addAudit(request.id, '复核通过：恢复限速', operator, `恢复正式限速${request.restoreSpeedLimit} km/h`)
        return { ok: true, message: `复核通过，${request.segmentId}恢复正式限速${request.restoreSpeedLimit} km/h` }
      }
      request.status = '已驳回'
      addAudit(request.id, '复核驳回', operator, `临时限速${request.keptTemporarySpeedLimit} km/h继续保持`)
      return { ok: true, message: `已驳回，临时限速${request.keptTemporarySpeedLimit} km/h继续保持` }
    })
  }

  function reset() {
    const fresh = seedState()
    segments.value = fresh.segments
    defects.value = fresh.defects
    audit.value = fresh.audit
    restorations.value = fresh.restorations
    appliedBatches.value = []
    journal.value = []
    stateVersion = 0
    try {
      const payload = buildPayload([])
      persistMain(payload)
      stateVersion = payload.stateVersion
    } catch {
      // 重置时写入失败仅保留内存状态
    }
    persistJournal()
  }

  // 启动时自动从未提交的完整批次恢复并继续处理
  recoverPendingBatches()

  return { segments, defects, audit, restorations, keyword, status, selectedSegmentId, filtered, selectedSegment, pendingRestorations, pendingBatches, assign, addAction, addRetest, transition, updateSegmentSpeed, decideRestoration, recoverPendingBatches, failNextWriteOnce, reset }
})
