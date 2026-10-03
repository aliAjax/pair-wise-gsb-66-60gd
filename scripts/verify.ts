/* 端到端验证：缺陷清零 → 待复核申请 → 临时限速保持 → 作废重算 / 并发冲突 / 批次恢复 / 幂等 */
import assert from 'node:assert'
import { resetIdSequence, type DomainState } from '../src/domain/recovery'
import { commitBatch, recoverPendingBatches, resetBatchSequence, type JournalEntry, type Persister } from '../src/domain/batch'
import type { Defect, TrackSegment } from '../src/types'

let writeFailures = 0
let writes = 0
let storage: any = null
const persister: Persister = {
  save(snapshot) {
    writes += 1
    if (writeFailures > 0) {
      writeFailures -= 1
      throw new Error('disk full')
    }
    storage = JSON.parse(JSON.stringify(snapshot))
  }
}

function makeState(): DomainState {
  resetIdSequence(0)
  resetBatchSequence(0)
  const segment: TrackSegment = { id: 'S1', line: '测试线 K1', startMileage: 1000, endMileage: 2000, speedLimit: 160, temporarySpeedLimit: 80, version: 1, measurements: [] }
  const defects: Defect[] = [
    { id: 'D1', segmentId: 'S1', mileage: 1200, type: '轨距', severity: '一级', measuredValue: 1450, limit: 1446, status: '整治中', owner: '一工区', discoveredAt: '', dueDate: '', actions: [{ method: '捣固', note: 'n', operator: '李', recordedAt: 't' }], retests: [], version: 3 },
    { id: 'D2', segmentId: 'S1', mileage: 1500, type: '高低', severity: '二级', measuredValue: 9, limit: 8, status: '整治中', owner: '一工区', discoveredAt: '', dueDate: '', actions: [], retests: [], version: 1 }
  ]
  return { segments: [segment], defects, audit: [], recoveryApplications: [], conflicts: [], appliedOps: {} }
}

function speedChanges(state: DomainState) {
  return state.segments[0].speedLimitChanges ?? []
}

let pass = 0
function check(name: string, fn: () => void) {
  fn()
  pass += 1
  console.log(`  ✓ ${name}`)
}

// 1. 清零 → 待复核申请，临时限速保持
{
  const state = makeState()
  const journal: JournalEntry[] = []
  commitBatch(state, journal, [
    { idempotencyKey: 'k1', type: 'submitRetest', payload: { defectId: 'D1', input: { measuredValue: 1440, tester: '王' } }, expectedVersion: 3 }
  ], persister)
  check('清零后形成待复核申请且仅一份', () => {
    const pending = state.recoveryApplications.filter((a) => a.status === '待复核')
    assert.equal(pending.length, 1)
    assert.equal(pending[0].heldTemporarySpeedLimit, 80)
    assert.equal(pending[0].basis.closedLevelOneDefectIds.join(','), 'D1')
  })
  check('复核通过前临时限速保持 80', () => assert.equal(state.segments[0].temporarySpeedLimit, 80))
  check('清零不产生限速解除记录', () => assert.equal(speedChanges(state).length, 0))

  // 2. 复核期间再出现未关闭一级缺陷 → 申请立即作废并重算
  const register = commitBatch(state, journal, [
    { idempotencyKey: 'k2', type: 'registerDefect', payload: { segmentId: 'S1', mileage: 1800, type: '方向', severity: '一级', measuredValue: 10, limit: 6 }, operator: '调度' }
  ], persister)
  void register
  check('新一级缺陷出现 → 原申请作废且无新待复核单', () => {
    const old = state.recoveryApplications.find((a) => a.status === '已作废' && a.basis.closedLevelOneDefectIds.join(',') === 'D1')!
    assert.ok(old)
    assert.match(old.reason ?? '', /未关闭一级缺陷/)
    assert.equal(state.recoveryApplications.filter((a) => a.status === '待复核').length, 0)
  })
  check('临时限速仍保持 80，无限速记录新增', () => {
    assert.equal(state.segments[0].temporarySpeedLimit, 80)
    assert.equal(speedChanges(state).length, 0)
  })

  // 新缺陷关闭 → 重新计算，产生新申请（依据包含两个缺陷）
  const newDefectId = state.defects[0].id // unshift 后的最新缺陷
  commitBatch(state, journal, [
    { idempotencyKey: 'k3', type: 'addRectification', payload: { defectId: newDefectId, action: { method: '打磨', note: '修', operator: '张', recordedAt: 't2' } } },
    { idempotencyKey: 'k4', type: 'submitRetest', payload: { defectId: newDefectId, input: { measuredValue: 5, tester: '王' } } }
  ], persister)
  check('再次清零 → 重新生成待复核申请（含全部一级缺陷）', () => {
    const pending = state.recoveryApplications.filter((a) => a.status === '待复核')
    assert.equal(pending.length, 1)
    assert.deepEqual(pending[0].basis.closedLevelOneDefectIds.sort(), ['D1', newDefectId].sort())
  })
}

// 3. 晚到的复测更正 → 申请作废并重算
{
  const state = makeState()
  const journal: JournalEntry[] = []
  commitBatch(state, journal, [{ idempotencyKey: 'a', type: 'submitRetest', payload: { defectId: 'D1', input: { measuredValue: 1440, tester: '王' } }, expectedVersion: 3 }], persister)
  commitBatch(state, journal, [{ idempotencyKey: 'b', type: 'correctRetest', payload: { defectId: 'D1', input: { measuredValue: 1449, tester: '王', note: '晚到更正' } }, operator: '调度' }], persister)
  check('复测由合格更正为不合格 → 申请作废且无待复核单', () => {
    assert.equal(state.recoveryApplications.filter((x) => x.status === '待复核').length, 0)
    assert.match(state.recoveryApplications.find((x) => x.status === '已作废')!.reason!, /复测结论更新/)
    assert.equal(state.defects.find((d) => d.id === 'D1')!.status, '复测不合格')
    assert.equal(state.defects.find((d) => d.id === 'D1')!.retests[0].corrected, true)
  })
  check('更正后临时限速保持，无限速记录', () => {
    assert.equal(state.segments[0].temporarySpeedLimit, 80)
    assert.equal(speedChanges(state).length, 0)
  })
}

// 4. 两名调度员同时提交复测：只先到者生效，后到者保留冲突
{
  const state = makeState()
  const journal: JournalEntry[] = []
  const r1 = commitBatch(state, journal, [{ idempotencyKey: 'p1', type: 'submitRetest', payload: { defectId: 'D1', input: { measuredValue: 1440, tester: '方林' } }, expectedVersion: 3 }], persister)
  const r2 = commitBatch(state, journal, [{ idempotencyKey: 'p2', type: 'submitRetest', payload: { defectId: 'D1', input: { measuredValue: 1438, tester: '赵晨' } }, expectedVersion: 3 }], persister)
  check('先到复测生效、缺陷关闭', () => {
    assert.equal(r1.results[0].ok, true)
    assert.equal(state.defects.find((d) => d.id === 'D1')!.status, '已关闭')
    assert.equal(state.defects.find((d) => d.id === 'D1')!.retests[0].tester, '方林')
  })
  check('后到复测冲突并保留，未覆盖先到结论', () => {
    assert.equal(r2.results[0].ok, false)
    assert.equal(r2.results[0].conflict, true)
    assert.equal(state.conflicts.length, 1)
    assert.equal(state.conflicts[0].expectedVersion, 3)
    assert.equal(state.conflicts[0].actualVersion, 4)
    assert.equal(state.defects.find((d) => d.id === 'D1')!.retests.length, 1)
  })
}

// 5. 两名调度员同时复核：只先到者生效
{
  const state = makeState()
  const journal: JournalEntry[] = []
  commitBatch(state, journal, [{ idempotencyKey: 'q1', type: 'submitRetest', payload: { defectId: 'D1', input: { measuredValue: 1440, tester: '王' } }, expectedVersion: 3 }], persister)
  const app = state.recoveryApplications.find((a) => a.status === '待复核')!
  const ok = commitBatch(state, journal, [{ idempotencyKey: 'q2', type: 'reviewRecovery', payload: { applicationId: app.id, approve: true, reviewer: '方林' }, expectedVersion: 1 }], persister)
  const late = commitBatch(state, journal, [{ idempotencyKey: 'q3', type: 'reviewRecovery', payload: { applicationId: app.id, approve: true, reviewer: '赵晨' }, expectedVersion: 1 }], persister)
  check('先到复核生效，临时限速解除且只生成一条限速记录', () => {
    assert.equal(ok.results[0].ok, true)
    assert.equal(state.segments[0].temporarySpeedLimit, undefined)
    assert.equal(speedChanges(state).length, 1)
  })
  check('后到复核冲突保留，不再生成限速记录', () => {
    assert.equal(late.results[0].conflict, true)
    assert.equal(speedChanges(state).length, 1)
    assert.equal(state.conflicts.length, 1)
  })
}

// 6. 写入失败 → 从完整批次恢复并接着处理
{
  const state = makeState()
  const journal: JournalEntry[] = []
  writeFailures = 1
  const before = JSON.stringify({ defects: state.defects.map((d) => [d.id, d.status, d.version]), temp: state.segments[0].temporarySpeedLimit })
  const failed = commitBatch(state, journal, [
    { idempotencyKey: 'f1', type: 'addRectification', payload: { defectId: 'D1', action: { method: '打磨', note: 'x', operator: '张', recordedAt: 'tt' } } },
    { idempotencyKey: 'f2', type: 'submitRetest', payload: { defectId: 'D1', input: { measuredValue: 1440, tester: '王' } }, expectedVersion: 3 }
  ], persister)
  check('写入失败：批次回滚到批次前完整状态', () => {
    assert.equal(failed.writeFailed, true)
    assert.equal(failed.recovered, true)
    const after = JSON.stringify({ defects: state.defects.map((d) => [d.id, d.status, d.version]), temp: state.segments[0].temporarySpeedLimit })
    assert.equal(after, before)
    assert.equal(state.recoveryApplications.length, 0)
  })
  check('日志保留待恢复批次', () => assert.equal(journal[0].status, '写入失败待恢复'))
  const recovered = recoverPendingBatches(state, journal, persister)
  check('恢复后批次完整执行：缺陷关闭、申请待复核、临时限速保持', () => {
    assert.equal(recovered[0].ok, true)
    assert.equal(state.defects.find((d) => d.id === 'D1')!.status, '已关闭')
    assert.equal(state.recoveryApplications.filter((a) => a.status === '待复核').length, 1)
    assert.equal(state.segments[0].temporarySpeedLimit, 80)
    assert.equal(speedChanges(state).length, 0)
  })
}

// 7. 重复提交幂等：不会多出限速记录 / 复测记录 / 申请
{
  const state = makeState()
  const journal: JournalEntry[] = []
  const ops = [{ idempotencyKey: 'dup', type: 'submitRetest' as const, payload: { defectId: 'D1', input: { measuredValue: 1440, tester: '王' } }, expectedVersion: 3 }]
  const first = commitBatch(state, journal, ops, persister)
  const again = commitBatch(state, journal, ops, persister)
  check('首次提交产生 1 份申请', () => assert.equal(first.results[0].replayed, undefined))
  check('重复提交原样回放、无副作用', () => {
    assert.equal(again.results[0].replayed, true)
    assert.equal(again.results[0].ok, true)
    assert.equal(state.recoveryApplications.filter((a) => a.status === '待复核').length, 1)
    assert.equal(state.defects.find((d) => d.id === 'D1')!.retests.length, 1)
    assert.equal(speedChanges(state).length, 0)
    assert.equal(state.audit.filter((e) => e.action === '提出限速恢复申请').length, 1)
  })
  // 恢复后对生效申请重复复核也不会多出限速记录
  const app = state.recoveryApplications.find((a) => a.status === '待复核')!
  const reviewOps = [{ idempotencyKey: 'dup-review', type: 'reviewRecovery' as const, payload: { applicationId: app.id, approve: true, reviewer: '方' }, expectedVersion: 1 }]
  commitBatch(state, journal, reviewOps, persister)
  commitBatch(state, journal, reviewOps, persister)
  check('复核重复提交：仅一条限速解除记录', () => assert.equal(speedChanges(state).length, 1))
}

// 8. 审计全程留痕
{
  const state = makeState()
  const journal: JournalEntry[] = []
  commitBatch(state, journal, [{ idempotencyKey: 'z', type: 'submitRetest', payload: { defectId: 'D1', input: { measuredValue: 1440, tester: '王' } }, expectedVersion: 3 }], persister)
  const actions = state.audit.map((e) => e.action)
  check('清零链路审计包含复测与申请提出', () => {
    assert.ok(actions.includes('提交复测'))
    assert.ok(actions.includes('提出限速恢复申请'))
  })
}

console.log(`\n全部 ${pass} 项检查通过`)
