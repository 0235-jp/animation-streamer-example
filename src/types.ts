export type MotionType =
  | 'idle'
  | 'idleToSpeech'
  | 'speechLoopLarge'
  | 'speechLoopSmall'
  | 'speechToIdle'

export type ClipOrigin = 'upload' | 'imageGenerator'

export interface ClipAsset {
  id: string
  file: File
  url: string
  name: string
  duration: number
  type: MotionType
  origin?: ClipOrigin
}

export interface AudioSegment {
  id: string
  kind: 'idle' | 'talk'
  start: number
  duration: number
}

export interface TimelinePlacement {
  clip: ClipAsset
  start: number
}

export interface TalkPlan {
  segmentId: string
  videoStart: number
  videoEnd: number
  audioStart: number
  audioDuration: number
}

export interface TimelinePlan {
  placements: TimelinePlacement[]
  talkPlans: TalkPlan[]
  totalDuration: number
}
