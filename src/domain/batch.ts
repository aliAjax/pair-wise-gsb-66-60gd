import type { Defect, DefectStatus } from '../types'
import {
  addRectification,
  assignDefects,
  correctRetest,
  registerApplicationConflict,
  registerDefect,
  registerDefectConflict,
  reviewRecovery,
  submitRetest,
  transitionStatus,
  updateSegmentSpeed,
  type DomainState,
  type OpResult,
  type RegisterDefectInput,
  type RetestInput
} from './recovery'

/** 一批处理：要么完整落盘，要么从完整批次回滚，绝不留半截状态 */
export interface BatchOp {
  /** 幂等键：同一操作重复提交只回放首次结果，不会多出限速记录 */
  idempotencyKey: string
  type:
    | 'registerDefect'
    | 'assignDefects'
    | 'addRectification'
    | 'submitRetest'
    | 'correctRetest'
    | 'transitionStatus'
    | 'updateSegmentSpeed'
    | 'reviewRecovery'
  payload?: any
  expectedVersion?: number
  operator?: string
}

export interface BatchResult {
  batchId: string
  ok: boolean
  /** 持久化写入是否失败（失败后已从批次前快照完整恢复） */
  writeFailed: boolean
  recovered: boolean
  results: Array<OpResult & { opIndex: number; idempotencyKey: string; replayed?: boolean }>
  message: string
}

let batchSeq = 0
function batchId(): string {
  batchSeq += 1
  return `BATCH-${Date.now().toString(36)}-${batchSeq}`
}
export function resetBatchSequence(value = 0): void {
  batchSeq = value
}

export interface JournalEntry {
  batchId: string
  ops: BatchOp[]
  status: '已落盘' | '写入失败待恢复'
  createdAt: string
  finishedAt?: string
}

export function applyOp(state: DomainState, op: BatchOp): OpResult {
  const operator = op.operator ?? '当前用户'
  switch (op.type) {
    case 'registerDefect':
      return registerDefect(state, op.payload as RegisterDefectInput, operator)
    case 'assignDefects': {
      const payload = op.payload as { defectIds: string[]; owner: string }
      return assignDefects(state, payload.defectIds, payload.owner, operator)
    }
    case 'addRectification': {
      const payload = op.payload as { defectId: string; action: Defect['actions'][number] }
      return addRectification(state, payload.defectId, payload.action)
    }
    case 'submitRetest': {
      const payload = op.payload as { defectId: string; input: RetestInput }
      return submitRetest(state, payload.defectId, payload.input, op.expectedVersion)
    }
    case 'correctRetest': {
      const payload = op.payload as { defectId: string; input: RetestInput }
      return correctRetest(state, payload.defectId, payload.input, operator)
    }
    case 'transitionStatus': {
      const payload = op.payload as { defectId: string; next: DefectStatus }
      return transitionStatus(state, payload.defectId, payload.next, operator)
    }
    case 'updateSegmentSpeed': {
      const payload = op.payload as { segmentId: string; speed: number; temporary: number | undefined }
      return updateSegmentSpeed(state, payload.segmentId, payload.speed, payload.temporary, operator)
    }
    case 'reviewRecovery': {
      const payload = op.payload as { applicationId: string; approve: boolean; reviewer: string }
      return reviewRecovery(state, payload.applicationId, payload.approve, payload.reviewer, op.expectedVersion)
    }
  }
}

export interface Persister {
  save(snapshot: DomainState & { journal: JournalEntry[] }): void
}

/**
 * 提交完整批次：
 * 1. 幂等键去重，重复提交直接回放；
 * 2. 先在批次前快照上顺序执行全部操作（冲突等业务结果保留，不中断批次）；
 * 3. 整批一次性持久化；写入失败则从完整批次快照恢复，调用方可接着重提；
 * 4. 成功后记录每个操作的幂等结果。
 */
export function commitBatch(state: DomainState, journal: JournalEntry[], ops: BatchOp[], persister: Persister, existingEntry?: JournalEntry): BatchResult {
  const id = existingEntry?.batchId ?? batchId()
  // 整批重复提交：所有幂等键都已有结果 → 原样回放，不产生任何副作用
  if (!existingEntry && ops.length && ops.every((op) => state.appliedOps[op.idempotencyKey])) {
    return {
      batchId: id,
      ok: true,
      writeFailed: false,
      recovered: false,
      results: ops.map((op, index) => ({ ...state.appliedOps[op.idempotencyKey], opIndex: index, idempotencyKey: op.idempotencyKey, replayed: true })),
      message: '重复提交已忽略，回放首次处理结果'
    }
  }

  const entry: JournalEntry = existingEntry ?? { batchId: id, ops, status: '写入失败待恢复', createdAt: new Date().toISOString() }
  if (!existingEntry) journal.unshift(entry)
  const snapshot = structuredClone(state)

  // 乐观并发预检：期望版本以"批次开始前"的已提交状态为准（同批次内前置操作的版本递增不在此列）
  function versionAtBatchStart(op: BatchOp): { current: number | undefined; entityId?: string } {
    if (op.type === 'submitRetest') {
      const defectId = op.payload?.defectId as string
      return { current: snapshot.defects.find((item) => item.id === defectId)?.version, entityId: defectId }
    }
    if (op.type === 'reviewRecovery') {
      const applicationId = op.payload?.applicationId as string
      return { current: snapshot.recoveryApplications.find((item) => item.id === applicationId)?.version, entityId: applicationId }
    }
    return { current: undefined }
  }

  const stale = new Map<number, OpResult>()
  if (!existingEntry) {
    ops.forEach((op, index) => {
      if (op.expectedVersion === undefined || state.appliedOps[op.idempotencyKey]) return
      const { current, entityId } = versionAtBatchStart(op)
      if (current !== undefined && current !== op.expectedVersion) {
        const detail = op.type === 'reviewRecovery'
          ? `${op.operator ?? '调度员'}对恢复申请${entityId}的复核晚到：申请已基于V${current}处理，V${op.expectedVersion}的提交保留为冲突`
          : `复测提交冲突：基于V${op.expectedVersion}的处理结果晚到，V${current}已由他人先提交`
        const conflictResult: OpResult = {
          ok: false,
          conflict: true,
          message: detail,
          entityId: op.type === 'reviewRecovery'
            ? registerApplicationConflict(state, entityId!, op.expectedVersion, current!, detail)
            : registerDefectConflict(state, op.payload!.defectId, op.expectedVersion, current!, detail)
        }
        stale.set(index, conflictResult)
      }
    })
  }

  const results: BatchResult['results'] = []
  for (let index = 0; index < ops.length; index += 1) {
    const op = ops[index]
    const existing = state.appliedOps[op.idempotencyKey]
    if (existing) {
      results.push({ ...existing, opIndex: index, idempotencyKey: op.idempotencyKey, replayed: true })
      continue
    }
    const staleResult = stale.get(index)
    if (staleResult) {
      state.appliedOps[op.idempotencyKey] = staleResult
      results.push({ ...staleResult, opIndex: index, idempotencyKey: op.idempotencyKey })
      continue
    }
    // 预检已负责跨批次并发；执行时去掉版本参数，避免同批次内前置操作造成误判
    const result = applyOp(state, { ...op, expectedVersion: undefined })
    state.appliedOps[op.idempotencyKey] = result
    results.push({ ...result, opIndex: index, idempotencyKey: op.idempotencyKey })
  }

  try {
    persister.save({ ...state, journal })
  } catch (error) {
    // 写入失败：丢弃所有内存改动，从批次前完整快照恢复，调用方可接着处理
    const restored = structuredClone(snapshot)
    state.segments = restored.segments
    state.defects = restored.defects
    state.audit = restored.audit
    state.recoveryApplications = restored.recoveryApplications
    state.conflicts = restored.conflicts
    state.appliedOps = restored.appliedOps
    entry.finishedAt = new Date().toISOString()
    const message = error instanceof Error ? error.message : String(error)
    return { batchId: id, ok: false, writeFailed: true, recovered: true, results: [], message: `持久化写入失败，已从完整批次恢复：${message}` }
  }

  entry.status = '已落盘'
  entry.finishedAt = new Date().toISOString()
  const blocked = results.filter((item) => !item.ok)
  return {
    batchId: id,
    ok: !blocked.length,
    writeFailed: false,
    recovered: false,
    results,
    message: blocked.length ? `批次已落盘，${blocked.length}项业务冲突/校验未通过并已保留` : `批次${id}已完整落盘`
  }
}

/**
 * 启动恢复：上次进程若在写入失败后中断，依据日志重放未完成批次。
 * 已记录幂等结果的操作自动跳过，不会重复产生限速记录。
 */
export function recoverPendingBatches(state: DomainState, journal: JournalEntry[], persister: Persister): BatchResult[] {
  // 上次进程在写入失败后中断：按日志顺序重放未完成批次（复用原批次号）；
  // 已记录幂等结果的操作自动跳过，不会重复产生限速记录。
  const pending = [...journal].reverse().filter((entry) => entry.status === '写入失败待恢复')
  return pending.map((entry) => commitBatch(state, journal, entry.ops, persister, entry))
}
