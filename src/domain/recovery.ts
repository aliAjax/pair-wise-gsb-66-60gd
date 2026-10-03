import type {
  AuditEntry,
  Defect,
  DefectStatus,
  ProcessingConflict,
  RecoveryApplication,
  RetestResult,
  TrackSegment
} from '../types'

/** 完整持久化状态：写入失败后从这个完整批次快照恢复 */
export interface DomainState {
  segments: TrackSegment[]
  defects: Defect[]
  audit: AuditEntry[]
  recoveryApplications: RecoveryApplication[]
  conflicts: ProcessingConflict[]
  /** 已完成的操作幂等键，重复提交直接回放结果、不产生副作用 */
  appliedOps: Record<string, OpResult>
}

export interface OpResult {
  ok: boolean
  conflict?: boolean
  message: string
  entityId?: string
}

let seq = 0
export function genId(prefix: string): string {
  seq += 1
  return `${prefix}-${Date.now().toString(36)}-${seq}`
}

export function resetIdSequence(value = 0): void {
  seq = value
}

export function openLevelOneDefects(state: DomainState, segmentId: string): Defect[] {
  return state.defects.filter((item) => item.segmentId === segmentId && item.severity === '一级' && item.status !== '已关闭')
}

/** 一级缺陷最新复测结论指纹，结论更新即变化 */
export function retestSignature(defect: Defect): string {
  const latest = defect.retests[0]
  if (!latest) return 'none'
  return `${latest.round}:${latest.passed ? 'pass' : 'fail'}:${latest.measuredValue}`
}

export function addAudit(state: DomainState, entityId: string, action: string, operator: string, detail: string, batchId?: string): void {
  state.audit.unshift({ id: genId('A'), entityId, action, operator, detail, createdAt: new Date().toISOString(), batchId })
}

function pendingApplication(state: DomainState, segmentId: string): RecoveryApplication | undefined {
  return state.recoveryApplications.find((item) => item.segmentId === segmentId && item.status === '待复核')
}

function voidApplication(state: DomainState, application: RecoveryApplication, reason: string, operator = '系统'): void {
  application.status = '已作废'
  application.reason = reason
  addAudit(state, application.id, '限速恢复申请作废', operator, `${state.segments.find((item) => item.id === application.segmentId)?.line ?? application.segmentId}：${reason}`)
}

/**
 * 清零重算：
 * - 同区段一级缺陷全部关闭 → 形成待复核申请，临时限速继续保持；
 * - 仍有未关闭一级缺陷或复测结论发生变化 → 在途申请立即作废并按新依据重新计算。
 * 纯函数式更新，本身幂等（相同依据重复调用不会重复建单）。
 */
export function recalculateRecovery(state: DomainState, segmentId: string, operator = '系统'): void {
  const segment = state.segments.find((item) => item.id === segmentId)
  if (!segment) return
  const existing = pendingApplication(state, segmentId)
  const open = openLevelOneDefects(state, segmentId)

  if (existing) {
    // 优先识别"晚到的复测更正"：申请依据中的缺陷复测指纹发生变化
    const changed = existing.basis.closedLevelOneDefectIds
      .map((id) => state.defects.find((defect) => defect.id === id))
      .filter((defect): defect is Defect => Boolean(defect))
      .filter((defect) => existing.basis.retestSignatures[defect.id] !== retestSignature(defect))
    if (changed.length) {
      const detail = changed
        .map((defect) => `${defect.id}（${existing.basis.retestSignatures[defect.id]} → ${retestSignature(defect)}）`)
        .join('、')
      voidApplication(state, existing, `复测结论更新：${detail}`, operator)
    } else if (open.length) {
      voidApplication(state, existing, `复核期间出现未关闭一级缺陷：${open.map((item) => item.id).join('、')}`, operator)
    }
  }

  // 作废后（或本就没有在途申请）按当前依据重新计算
  if (pendingApplication(state, segmentId)) return
  if (open.length) return

  const levelOne = state.defects.filter((item) => item.segmentId === segmentId && item.severity === '一级')
  if (!levelOne.length) return

  const signatures: Record<string, string> = {}
  for (const defect of levelOne) signatures[defect.id] = retestSignature(defect)

  const heldTemporary = segment.temporarySpeedLimit
  const application: RecoveryApplication = {
    id: genId('RA'),
    segmentId,
    heldTemporarySpeedLimit: heldTemporary,
    formalSpeedLimit: segment.speedLimit,
    status: '待复核',
    basis: { closedLevelOneDefectIds: levelOne.map((item) => item.id), retestSignatures: signatures },
    reason: null,
    createdAt: new Date().toISOString(),
    createdBy: operator,
    version: 1
  }
  state.recoveryApplications.unshift(application)
  addAudit(
    state,
    application.id,
    '提出限速恢复申请',
    operator,
    `${segment.line}同区段一级缺陷已清零（${application.basis.closedLevelOneDefectIds.join('、')}），临时限速${heldTemporary ?? '无'} km/h 暂保持，等待调度复核`
  )
}

export interface RegisterDefectInput {
  id?: string
  segmentId: string
  mileage: number
  type: Defect['type']
  severity: Defect['severity']
  measuredValue: number
  limit: number
  owner?: string
  discoveredAt?: string
  dueDate?: string
}

export function registerDefect(state: DomainState, input: RegisterDefectInput, operator: string): OpResult {
  const segment = state.segments.find((item) => item.id === input.segmentId)
  if (!segment) return { ok: false, message: '区段不存在' }
  const id = input.id ?? genId('GD')
  if (state.defects.some((item) => item.id === id)) return { ok: false, message: '缺陷编号已存在', entityId: id }
  const now = new Date().toISOString()
  state.defects.unshift({
    id,
    segmentId: input.segmentId,
    mileage: input.mileage,
    type: input.type,
    severity: input.severity,
    measuredValue: input.measuredValue,
    limit: input.limit,
    status: '待派工',
    owner: input.owner ?? '',
    discoveredAt: input.discoveredAt ?? now,
    dueDate: input.dueDate ?? now.slice(0, 10),
    actions: [],
    retests: [],
    version: 1
  })
  addAudit(state, id, '登记缺陷', operator, `${input.severity}${input.type}缺陷，实测${input.measuredValue}/限值${input.limit}`)
  recalculateRecovery(state, input.segmentId, operator)
  return { ok: true, message: '缺陷已登记', entityId: id }
}

export function assignDefects(state: DomainState, defectIds: string[], owner: string, operator: string): OpResult {
  let touchedSegments = new Set<string>()
  for (const id of defectIds) {
    const defect = state.defects.find((item) => item.id === id)
    if (!defect) continue
    defect.owner = owner
    defect.status = '整治中'
    defect.version += 1
    touchedSegments.add(defect.segmentId)
    addAudit(state, id, '批量派工', operator, `任务分配至${owner}，版本升至V${defect.version}`)
  }
  touchedSegments.forEach((segmentId) => recalculateRecovery(state, segmentId, operator))
  return { ok: true, message: `已派工${defectIds.length}项` }
}

export function addRectification(state: DomainState, defectId: string, action: Defect['actions'][number]): OpResult {
  const defect = state.defects.find((item) => item.id === defectId)
  if (!defect) return { ok: false, message: '缺陷不存在' }
  defect.actions.unshift(action)
  defect.status = '待复测'
  defect.version += 1
  addAudit(state, defectId, '提交整治记录', action.operator, `${action.method}：${action.note}，版本升至V${defect.version}`)
  recalculateRecovery(state, defect.segmentId, action.operator)
  return { ok: true, message: '整治记录已提交' }
}

export interface RetestInput {
  measuredValue: number
  tester: string
  note?: string
  testedAt?: string
}

function pushRetest(defect: Defect, input: RetestInput): RetestResult {
  const round = defect.retests.length + 1
  const passed = input.measuredValue <= defect.limit
  const retest: RetestResult = {
    round,
    passed,
    measuredValue: input.measuredValue,
    limit: defect.limit,
    note: input.note ?? (passed ? '复测合格' : '仍超过限值'),
    tester: input.tester,
    testedAt: input.testedAt ?? new Date().toISOString()
  }
  defect.retests.unshift(retest)
  defect.status = passed ? '已关闭' : '复测不合格'
  defect.version += 1
  return retest
}

/**
 * 提交复测。expectedVersion 提供乐观并发：
 * 两名调度员基于同一版本提交时，只有先到者生效，后到者登记冲突并保留。
 */
export function submitRetest(state: DomainState, defectId: string, input: RetestInput, expectedVersion?: number): OpResult {
  const defect = state.defects.find((item) => item.id === defectId)
  if (!defect) return { ok: false, message: '缺陷不存在' }
  if (expectedVersion !== undefined && defect.version !== expectedVersion) {
    return recordConflict(
      state,
      defect.segmentId,
      undefined,
      expectedVersion,
      defect.version,
      `复测提交冲突：${input.tester}基于V${expectedVersion}的处理结果晚到，V${defect.version}已由他人先提交`,
      defectId
    )
  }
  const retest = pushRetest(defect, input)
  addAudit(state, defectId, '提交复测', input.tester, retest.passed ? `第${retest.round}轮复测通过，缺陷关闭` : `第${retest.round}轮复测未通过，重新进入整治`)
  recalculateRecovery(state, defect.segmentId, input.tester)
  return { ok: true, message: retest.passed ? '复测通过，缺陷已关闭，限速恢复待复核' : '复测不合格，任务重新进入整治' }
}

/**
 * 晚到的复测更正：覆盖最近一轮结论（保留原结论留痕），在途恢复申请立即作废并重算。
 */
export function correctRetest(state: DomainState, defectId: string, input: RetestInput, operator: string): OpResult {
  const defect = state.defects.find((item) => item.id === defectId)
  if (!defect) return { ok: false, message: '缺陷不存在' }
  if (!defect.retests.length) return { ok: false, message: '尚无复测结论，不能更正' }
  const original = { ...defect.retests[0] }
  const round = original.round
  const passed = input.measuredValue <= defect.limit
  const corrected: RetestResult = {
    round,
    passed,
    measuredValue: input.measuredValue,
    limit: defect.limit,
    note: input.note ?? `更正复测：${passed ? '合格' : '不合格'}`,
    tester: input.tester ?? original.tester,
    testedAt: input.testedAt ?? new Date().toISOString(),
    corrected: true,
    correctedFrom: original
  }
  defect.retests[0] = corrected
  defect.status = passed ? '已关闭' : '复测不合格'
  defect.version += 1
  addAudit(state, defectId, '复测结论更正', operator, `第${round}轮结论由${original.passed ? '合格' : '不合格'}(${original.measuredValue})更正为${passed ? '合格' : '不合格'}(${input.measuredValue})，版本升至V${defect.version}`)
  recalculateRecovery(state, defect.segmentId, operator)
  return { ok: true, message: passed ? '更正为合格，已重新计算恢复申请' : '更正为不合格，在途恢复申请已作废', entityId: defectId }
}

export function transitionStatus(state: DomainState, defectId: string, next: DefectStatus, operator = '当前用户'): OpResult {
  const defect = state.defects.find((item) => item.id === defectId)
  if (!defect) return { ok: false, message: '缺陷不存在' }
  if (next === '已关闭' && (!defect.retests.length || !defect.retests.some((item) => item.passed))) return { ok: false, message: '没有合格复测记录，不能关闭' }
  if (next === '待复测' && !defect.actions.length) return { ok: false, message: '缺少整治记录，不能申请复测' }
  const previous = defect.status
  defect.status = next
  defect.version += 1
  addAudit(state, defectId, `状态流转：${next}`, operator, `由${previous}流转至${next}，版本升至V${defect.version}`)
  recalculateRecovery(state, defect.segmentId, operator)
  return { ok: true, message: `已流转至${next}` }
}

export function registerDefectConflict(state: DomainState, defectId: string, expectedVersion: number, actualVersion: number, detail: string): string {
  const conflict = pushConflict(state, state.defects.find((item) => item.id === defectId)?.segmentId ?? '', undefined, expectedVersion, actualVersion, detail)
  addAudit(state, defectId, '并发处理冲突', '系统', `${detail}；后到结果已保留为冲突${conflict}，先到者生效`)
  return conflict
}

export function registerApplicationConflict(state: DomainState, applicationId: string, expectedVersion: number, actualVersion: number, detail: string): string {
  const segmentId = state.recoveryApplications.find((item) => item.id === applicationId)?.segmentId ?? ''
  const conflict = pushConflict(state, segmentId, applicationId, expectedVersion, actualVersion, detail)
  addAudit(state, applicationId, '并发处理冲突', '系统', `${detail}；后到结果已保留为冲突${conflict}，先到者生效`)
  return conflict
}

function pushConflict(state: DomainState, segmentId: string, applicationId: string | undefined, expectedVersion: number, actualVersion: number, detail: string): string {
  const id = genId('CF')
  state.conflicts.unshift({
    id,
    applicationId: applicationId ?? '',
    segmentId,
    winner: `先到提交（V${actualVersion}）`,
    loser: detail,
    detail,
    expectedVersion,
    actualVersion,
    createdAt: new Date().toISOString(),
    resolved: false
  })
  return id
}

function recordConflict(state: DomainState, segmentId: string, applicationId: string | undefined, expectedVersion: number, actualVersion: number, detail: string, defectId?: string): OpResult {
  const id = pushConflict(state, segmentId, applicationId, expectedVersion, actualVersion, detail)
  addAudit(state, defectId ?? applicationId ?? segmentId, '并发处理冲突', '系统', `${detail}；后到结果已保留为冲突${id}，先到者生效`)
  return { ok: false, conflict: true, message: detail, entityId: id }
}

export function updateSegmentSpeed(state: DomainState, segmentId: string, speed: number, temporary: number | undefined, operator = '工务调度'): OpResult {
  const segment = state.segments.find((item) => item.id === segmentId)
  if (!segment) return { ok: false, message: '区段不存在' }
  const conflict = openLevelOneDefects(state, segmentId).length > 0
  if (conflict && (!temporary || temporary >= speed)) return { ok: false, message: '一级缺陷未关闭时必须设置更低临时限速' }
  segment.speedLimitChanges ??= []
  segment.speedLimitChanges.unshift({
    id: genId('SC'),
    speedLimit: speed,
    temporarySpeedLimit: temporary,
    reason: conflict ? '一级缺陷未关闭，维持临时限速联查' : '人工调整速度版本',
    operator,
    changedAt: new Date().toISOString()
  })
  segment.speedLimit = speed
  segment.temporarySpeedLimit = temporary
  segment.version += 1
  addAudit(state, segmentId, '更新区段速度版本', operator, `正式限速${speed} km/h，临时限速${temporary ?? '无'}，版本升至V${segment.version}`)
  // 人工改了临时限速：在途恢复申请依据失效，需调度重新发起
  const pending = state.recoveryApplications.find((item) => item.segmentId === segmentId && item.status === '待复核')
  if (pending) voidApplication(state, pending, `临时限速被人工调整为${temporary ?? '无'} km/h`, operator)
  return { ok: true, message: '区段速度版本已更新' }
}

/**
 * 调度员复核限速恢复申请。
 * 两名调度员同时复核时只让先到者生效：后到者基于过期 application.version，登记冲突并保留。
 */
export function reviewRecovery(state: DomainState, applicationId: string, approve: boolean, reviewer: string, expectedVersion?: number): OpResult {
  const application = state.recoveryApplications.find((item) => item.id === applicationId)
  if (!application) return { ok: false, message: '恢复申请不存在' }
  // 先做乐观并发：基于过期版本提交的后到者一律登记冲突并保留（即使申请已被先到者处理）
  if (expectedVersion !== undefined && application.version !== expectedVersion) {
    return recordConflict(
      state,
      application.segmentId,
      applicationId,
      expectedVersion,
      application.version,
      `${reviewer}对恢复申请${applicationId}的复核晚到：申请已基于V${application.version}处理，V${expectedVersion}的提交保留为冲突`
    )
  }
  if (application.status !== '待复核') return { ok: false, conflict: true, message: `申请已${application.status}，无需重复复核` }

  // 复核瞬间再做一次守卫：复核期间任何依据变化都应已由重算作废，这里双保险
  const open = openLevelOneDefects(state, application.segmentId)
  if (open.length) {
    voidApplication(state, application, `复核时点仍存在未关闭一级缺陷：${open.map((item) => item.id).join('、')}`, reviewer)
    return { ok: false, message: '复核未通过：仍有未关闭一级缺陷' }
  }

  const segment = state.segments.find((item) => item.id === application.segmentId)
  if (!segment) return { ok: false, message: '区段不存在' }

  application.reviewedAt = new Date().toISOString()
  application.reviewedBy = reviewer
  application.version += 1

  if (!approve) {
    application.status = '已作废'
    application.reason = `调度${reviewer}复核驳回`
    addAudit(state, applicationId, '限速恢复申请驳回', reviewer, '复核驳回，临时限速继续保持')
    return { ok: true, message: '已驳回，临时限速保持' }
  }

  application.status = '已生效'
  segment.speedLimitChanges ??= []
  segment.speedLimitChanges.unshift({
    id: genId('SC'),
    speedLimit: segment.speedLimit,
    temporarySpeedLimit: undefined,
    reason: `恢复申请${applicationId}复核通过，一级缺陷清零`,
    operator: reviewer,
    changedAt: new Date().toISOString()
  })
  segment.temporarySpeedLimit = undefined
  segment.version += 1
  addAudit(state, applicationId, '限速恢复生效', reviewer, `${segment.line}临时限速解除，恢复正式限速${segment.speedLimit} km/h，区段版本升至V${segment.version}`)
  return { ok: true, message: `复核通过，临时限速已解除`, entityId: applicationId }
}

export function resolveConflict(state: DomainState, conflictId: string, operator = '调度员'): OpResult {
  const conflict = state.conflicts.find((item) => item.id === conflictId)
  if (!conflict) return { ok: false, message: '冲突不存在' }
  conflict.resolved = true
  addAudit(state, conflictId, '冲突已处理', operator, '后到提交确认作废，以先到者结果为准')
  return { ok: true, message: '冲突已标记处理' }
}
