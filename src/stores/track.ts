import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import { seedAudit, seedDefects, seedSegments } from '../data/seed'
import type { AuditEntry, Defect, DefectStatus, ProcessingConflict, RectificationAction, RecoveryApplication, RetestResult, TrackSegment } from '../types'
import { recalculateRecovery, type DomainState } from '../domain/recovery'
import { commitBatch, recoverPendingBatches, type BatchOp, type BatchResult, type JournalEntry, type Persister } from '../domain/batch'

const STORAGE_KEY = 'gsb66:track-geometry'
let idSeed = 10

interface PersistedState {
  segments: TrackSegment[]
  defects: Defect[]
  audit: AuditEntry[]
  recoveryApplications: RecoveryApplication[]
  conflicts: ProcessingConflict[]
  appliedOps: DomainState['appliedOps']
  journal: JournalEntry[]
}

/** 下一次显式持久化强制失败，用于模拟写入失败后的恢复流程 */
let failNextWrite = false
export function simulateNextWriteFailure(): void {
  failNextWrite = true
}

const persister: Persister = {
  save(snapshot) {
    const text = JSON.stringify(snapshot)
    if (failNextWrite) {
      failNextWrite = false
      throw new Error('本地持久化写入失败（模拟）')
    }
    localStorage.setItem(STORAGE_KEY, text)
  }
}

function migrate(raw: Partial<PersistedState>): PersistedState {
  return {
    segments: raw.segments ?? structuredClone(seedSegments),
    defects: raw.defects ?? structuredClone(seedDefects),
    audit: raw.audit ?? structuredClone(seedAudit),
    recoveryApplications: raw.recoveryApplications ?? [],
    conflicts: raw.conflicts ?? [],
    appliedOps: raw.appliedOps ?? {},
    journal: raw.journal ?? []
  }
}

function load(): PersistedState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return migrate(raw ? JSON.parse(raw) : {})
  } catch {
    return migrate({})
  }
}

export const useTrackStore = defineStore('track', () => {
  const initial = load()
  const segments = ref<TrackSegment[]>(initial.segments)
  const defects = ref<Defect[]>(initial.defects)
  const audit = ref<AuditEntry[]>(initial.audit)
  const recoveryApplications = ref<RecoveryApplication[]>(initial.recoveryApplications)
  const conflicts = ref<ProcessingConflict[]>(initial.conflicts)
  const appliedOps = ref<DomainState['appliedOps']>(initial.appliedOps)
  const journal = ref<JournalEntry[]>(initial.journal)
  const keyword = ref('')
  const status = ref<DefectStatus | '全部'>('全部')
  const selectedSegmentId = ref(segments.value[0]?.id ?? '')

  // 启动：先重放写入失败后中断的批次，再为旧数据补齐待复核申请（已清零但临时限速仍在）
  function initialDomainState(): DomainState {
    return { segments: segments.value, defects: defects.value, audit: audit.value, recoveryApplications: recoveryApplications.value, conflicts: conflicts.value, appliedOps: appliedOps.value }
  }
  recoverPendingBatches(initialDomainState(), journal.value, persister)
  for (const segment of segments.value) {
    const hasPending = recoveryApplications.value.some((item) => item.segmentId === segment.id && item.status === '待复核')
    const hasLevelOne = defects.value.some((item) => item.segmentId === segment.id && item.severity === '一级')
    if (!hasPending && hasLevelOne && segment.temporarySpeedLimit !== undefined) {
      recalculateRecovery(initialDomainState(), segment.id, '系统迁移')
    }
  }

  function domainState(): DomainState {
    // 使用访问器绑定 ref：批次回滚时对属性的整体赋值才能真正写回响应式状态
    return {
      get segments() { return segments.value },
      set segments(value) { segments.value = value },
      get defects() { return defects.value },
      set defects(value) { defects.value = value },
      get audit() { return audit.value },
      set audit(value) { audit.value = value },
      get recoveryApplications() { return recoveryApplications.value },
      set recoveryApplications(value) { recoveryApplications.value = value },
      get conflicts() { return conflicts.value },
      set conflicts(value) { conflicts.value = value },
      get appliedOps() { return appliedOps.value },
      set appliedOps(value) { appliedOps.value = value }
    }
  }

  /** 所有写操作统一走完整批次：失败自动回滚到批次前快照，成功才整体落盘 */
  function commit(ops: BatchOp[], idempotencyKey?: string): BatchResult {
    const opsWithKey = idempotencyKey
      ? ops.map((op, index) => ({ ...op, idempotencyKey: index === 0 ? idempotencyKey : `${idempotencyKey}:${index}` }))
      : ops
    return commitBatch(domainState(), journal.value, opsWithKey, persister)
  }

  const filtered = computed(() => defects.value.filter((item) => {
    const segment = segments.value.find((value) => value.id === item.segmentId)
    const text = `${item.id} ${segment?.line ?? ''} ${item.type} ${item.owner}`.toLowerCase()
    return (!keyword.value || text.includes(keyword.value.toLowerCase())) && (status.value === '全部' || item.status === status.value)
  }))

  const selectedSegment = computed(() => segments.value.find((item) => item.id === selectedSegmentId.value))

  function pendingRecoveryFor(segmentId: string) {
    return recoveryApplications.value.find((item) => item.segmentId === segmentId && item.status === '待复核')
  }

  function assign(defectIds: string[], owner: string) {
    return commit([{ idempotencyKey: `assign:${defectIds.slice().sort().join(',')}:${owner}:${Date.now()}`, type: 'assignDefects', payload: { defectIds, owner }, operator: '当前用户' }])
  }

  function addAction(id: string, action: RectificationAction) {
    return commit([{ idempotencyKey: `action:${id}:${action.recordedAt}:${action.note}`, type: 'addRectification', payload: { defectId: id, action } }])
  }

  function addRetest(id: string, retest: RetestResult, expectedVersion?: number) {
    const { round: _round, passed: _passed, limit: _limit, corrected: _c, correctedFrom: _cf, ...input } = retest
    return commit([{ idempotencyKey: `retest:${id}:${retest.testedAt}:${retest.measuredValue}`, type: 'submitRetest', payload: { defectId: id, input }, expectedVersion }])
  }

  function correctRetestResult(id: string, input: { measuredValue: number; tester: string; note?: string; testedAt?: string }) {
    return commit([{ idempotencyKey: `retest-correct:${id}:${input.testedAt ?? new Date().toISOString()}:${input.measuredValue}`, type: 'correctRetest', payload: { defectId: id, input }, operator: '当前用户' }])
  }

  function registerLevelOneDefect(input: { segmentId: string; mileage: number; type: Defect['type']; measuredValue: number; limit: number; owner?: string }) {
    return commit([{ idempotencyKey: `register:${input.segmentId}:${input.mileage}:${input.measuredValue}:${Date.now()}`, type: 'registerDefect', payload: { ...input, severity: '一级' as const }, operator: '当前用户' }])
  }

  function transition(id: string, next: DefectStatus) {
    const result = commit([{ idempotencyKey: `transition:${id}:${next}:${Date.now()}`, type: 'transitionStatus', payload: { defectId: id, next } }])
    return result.results[0] ?? { ok: false, message: result.message }
  }

  function reviewRecoveryApplication(applicationId: string, approve: boolean, reviewer: string, expectedVersion?: number) {
    return commit([{ idempotencyKey: `review:${applicationId}:${reviewer}:${expectedVersion ?? 'any'}`, type: 'reviewRecovery', payload: { applicationId, approve, reviewer }, expectedVersion }])
  }

  function resolveConflict(conflictId: string) {
    const state = domainState()
    const conflict = state.conflicts.find((item) => item.id === conflictId)
    if (!conflict) return { ok: false, message: '冲突不存在' }
    if (conflict.resolved) return { ok: true, message: '冲突已处理' }
    conflict.resolved = true
    state.audit.unshift({ id: `A-${Date.now()}-${idSeed++}`, entityId: conflictId, action: '冲突已处理', operator: '当前调度员', detail: '后到提交确认作废，以先到者结果为准', createdAt: new Date().toISOString() })
    return { ok: true, message: '冲突已标记处理' }
  }

  function updateSegmentSpeed(id: string, speed: number, temporary: number | undefined) {
    const result = commit([{ idempotencyKey: `speed:${id}:${speed}:${temporary ?? 'none'}:${Date.now()}`, type: 'updateSegmentSpeed', payload: { segmentId: id, speed, temporary }, operator: '工务调度' }])
    return result.results[0] ?? { ok: false, message: result.message }
  }

  /** 重算指定区段的恢复申请（供恢复流程或外部事件触发） */
  function recalculate(segmentId: string) {
    recalculateRecovery(domainState(), segmentId, '当前用户')
  }

  /** 写入失败后从完整批次日志恢复，接着处理未完成批次 */
  function recoverPending() {
    return recoverPendingBatches(domainState(), journal.value, persister)
  }

  function reset() {
    segments.value = structuredClone(seedSegments)
    defects.value = structuredClone(seedDefects)
    audit.value = structuredClone(seedAudit)
    recoveryApplications.value = []
    conflicts.value = []
    appliedOps.value = {}
    journal.value = []
  }

  watch(
    [segments, defects, audit, recoveryApplications, conflicts, appliedOps, journal],
    () => {
      // 常规响应式变更（如冲突标记）做兜底落盘；批次内的正式写入由 persister 统一完成
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({
          segments: segments.value,
          defects: defects.value,
          audit: audit.value,
          recoveryApplications: recoveryApplications.value,
          conflicts: conflicts.value,
          appliedOps: appliedOps.value,
          journal: journal.value
        }))
      } catch {
        // 兜底写入失败不影响批次回滚语义
      }
    },
    { deep: true }
  )

  return {
    segments, defects, audit, recoveryApplications, conflicts, journal,
    keyword, status, selectedSegmentId, filtered, selectedSegment,
    assign, addAction, addRetest, correctRetestResult, registerLevelOneDefect,
    transition, reviewRecoveryApplication, resolveConflict, updateSegmentSpeed,
    pendingRecoveryFor, recalculate, recoverPending, reset
  }
})
