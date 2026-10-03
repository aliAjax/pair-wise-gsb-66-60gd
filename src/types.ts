export type DefectStatus = '待派工' | '整治中' | '待复测' | '复测不合格' | '已关闭'
export type DefectType = '轨距' | '高低' | '方向' | '三角坑'
export type Severity = '一级' | '二级' | '三级'

export interface GeometryMeasurement {
  id: string
  mileage: number
  gauge: number
  level: number
  alignment: number
  twist: number
  measuredAt: string
  detector: string
}

export interface SpeedLimitChange {
  id: string
  speedLimit: number
  temporarySpeedLimit?: number
  reason: string
  operator: string
  changedAt: string
}

export interface TrackSegment {
  id: string
  line: string
  startMileage: number
  endMileage: number
  speedLimit: number
  temporarySpeedLimit?: number
  version: number
  measurements: GeometryMeasurement[]
  speedLimitChanges?: SpeedLimitChange[]
}

export interface RectificationAction {
  method: '打磨' | '捣固' | '更换' | '垫板调整' | '测量复核'
  note: string
  operator: string
  recordedAt: string
}

export interface RetestResult {
  round: number
  passed: boolean
  measuredValue: number
  limit: number
  note: string
  tester: string
  testedAt: string
  corrected?: boolean
  correctedFrom?: RetestResult
}

export interface Defect {
  id: string
  segmentId: string
  mileage: number
  type: DefectType
  severity: Severity
  measuredValue: number
  limit: number
  status: DefectStatus
  owner: string
  discoveredAt: string
  dueDate: string
  actions: RectificationAction[]
  retests: RetestResult[]
  version: number
}

export type RecoveryStatus = '待复核' | '已生效' | '已作废'

export interface RecoveryApplication {
  id: string
  segmentId: string
  /** 申请提出时刻仍在执行的临时限速，复核通过前保持不变 */
  heldTemporarySpeedLimit?: number
  formalSpeedLimit: number
  status: RecoveryStatus
  basis: {
    closedLevelOneDefectIds: string[]
    /** 清零时各一级缺陷复测结论指纹，用于识别"晚到的复测更正" */
    retestSignatures: Record<string, string>
  }
  reason: string | null
  createdAt: string
  createdBy: string
  /** 乐观并发：处置/复核必须基于该版本提交 */
  version: number
  reviewedAt?: string
  reviewedBy?: string
}

export interface ProcessingConflict {
  id: string
  applicationId: string
  segmentId: string
  winner: string
  loser: string
  detail: string
  expectedVersion: number
  actualVersion: number
  createdAt: string
  resolved: boolean
}

export interface AuditEntry {
  id: string
  entityId: string
  action: string
  operator: string
  detail: string
  createdAt: string
  batchId?: string
}
