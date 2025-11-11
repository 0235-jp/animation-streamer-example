import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ChangeEvent, DragEvent } from 'react'
import type { FFmpeg as FFmpegInstance } from '@ffmpeg/ffmpeg'
import type JSZip from 'jszip'
import './App.css'
import {
  analyzeAudio,
  audioBufferToWav,
  buildAlignedAudioBuffer,
  formatSeconds,
  type AudioAnalysisResult,
} from './lib/audio'
import { buildTimelinePlan } from './lib/timeline'
import {
  fetchVoicevoxCloudSpeakers,
  synthesizeVoicevox,
  synthesizeVoicevoxCloud,
  synthesizeVoicevoxFast,
} from './lib/tts'
import type { ClipAsset, ClipOrigin, MotionType, TimelinePlan } from './types'

const motionLabels: Record<MotionType, string> = {
  idle: '待機',
  idleToSpeech: '待機→発話',
  speechLoopLarge: '発話→発話(大)',
  speechLoopSmall: '発話→発話(小)',
  speechToIdle: '発話→待機',
}

type TtsProvider = 'local' | 'cloudSlow' | 'cloudFast'

interface TtsUiConfig {
  localEndpoint: string
  localSpeakerId: string
  cloudSlowSpeakerId: string
  cloudFastSpeakerId: string
  cloudFastApiKey: string
}

interface VoicevoxSpeakerOption {
  id: number
  label: string
}

const TTS_STORAGE_KEY = 'animation-streamer-example::tts-config'
const TTS_PROVIDER_KEY = 'animation-streamer-example::tts-provider'
const AUDIO_MODE_KEY = 'animation-streamer-example::audio-mode'
const CLIP_MODE_STORAGE_KEY = 'animation-streamer-example::clip-mode'
const IMAGE_GENERATOR_OPTIONS_KEY = 'animation-streamer-example::image-generator-options'

type ClipInputMode = 'upload' | 'image'
type MouthImageKind = 'closed' | 'open'

interface MouthImageSlot {
  file: File | null
  previewUrl: string | null
  width: number | null
  height: number | null
}

interface ImageGeneratorOptions {
  frameDuration: number
}

const defaultImageGeneratorOptions: ImageGeneratorOptions = {
  frameDuration: 0.08,
}

const clipGenerationOrder: MotionType[] = ['idle', 'idleToSpeech', 'speechToIdle', 'speechLoopSmall', 'speechLoopLarge']

const mouthImageLabels: Record<MouthImageKind, string> = {
  closed: '口を閉じている画像',
  open: '口を開いている画像',
}

const mouthImageOrder: MouthImageKind[] = ['closed', 'open']

const createEmptyMouthImageSlot = (): MouthImageSlot => ({
  file: null,
  previewUrl: null,
  width: null,
  height: null,
})

const MOUTH_IMAGE_ACCEPT = 'image/png,image/jpeg,image/webp'
const MAX_IMAGE_FILE_SIZE = 10 * 1024 * 1024
const MAX_IMAGE_DIMENSION = 4096
const MIN_FRAME_DURATION = 0.03
const MAX_FRAME_DURATION = 1
const ASPECT_RATIO_WARNING_THRESHOLD = 0.3
const IMAGE_CANVAS_BACKGROUND = '#ffffff'

const buildDefaultImageGeneratorOptions = (): ImageGeneratorOptions => ({ ...defaultImageGeneratorOptions })

const coerceImageGeneratorOptions = (raw: unknown): ImageGeneratorOptions => {
  if (!raw || typeof raw !== 'object') return buildDefaultImageGeneratorOptions()
  const data = raw as Partial<ImageGeneratorOptions>
  const frameDurationValue = typeof data.frameDuration === 'number' ? data.frameDuration : Number(data.frameDuration)
  const frameDuration = Number.isFinite(frameDurationValue)
    ? Math.min(MAX_FRAME_DURATION, Math.max(MIN_FRAME_DURATION, frameDurationValue))
    : defaultImageGeneratorOptions.frameDuration
  return {
    frameDuration,
  }
}

const persistImageGeneratorOptions = (options: ImageGeneratorOptions) => {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(
      IMAGE_GENERATOR_OPTIONS_KEY,
      JSON.stringify({ imageGen: options })
    )
  } catch {
    // ignore
  }
}

const readStoredImageGeneratorOptions = (): ImageGeneratorOptions => {
  if (typeof window === 'undefined') return buildDefaultImageGeneratorOptions()
  try {
    const raw = window.localStorage.getItem(IMAGE_GENERATOR_OPTIONS_KEY)
    if (!raw) return buildDefaultImageGeneratorOptions()
    const parsed = JSON.parse(raw) as { imageGen?: unknown }
    if (parsed.imageGen) return coerceImageGeneratorOptions(parsed.imageGen)
  } catch {
    // ignore
  }
  return buildDefaultImageGeneratorOptions()
}

const readStoredClipMode = (): ClipInputMode => {
  if (typeof window === 'undefined') return 'upload'
  try {
    const raw = window.localStorage.getItem(CLIP_MODE_STORAGE_KEY)
    return raw === 'image' ? 'image' : 'upload'
  } catch {
    return 'upload'
  }
}

const clipFrameRecipes: Record<MotionType, MouthImageKind[]> = {
  idle: ['closed'],
  idleToSpeech: ['closed', 'open'],
  speechLoopSmall: ['open', 'closed', 'open'],
  speechLoopLarge: ['open', 'closed', 'open'],
  speechToIdle: ['open', 'closed'],
}

const mouthImageFilenames: Record<MouthImageKind, string> = {
  closed: 'mouth_closed.png',
  open: 'mouth_open.png',
}

interface CodecPreset {
  extension: string
  mimeType: string
  outputArgs: string[]
}
const defaultCodecPreset: CodecPreset = {
  extension: 'mp4',
  mimeType: 'video/mp4',
  outputArgs: [
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-profile:v',
    'baseline',
    '-level',
    '3.0',
    '-movflags',
    '+faststart',
    '-preset',
    'veryfast',
    '-crf',
    '23',
  ],
}

const defaultTtsConfig: TtsUiConfig = {
  localEndpoint: 'http://localhost:50021',
  localSpeakerId: '3',
  cloudSlowSpeakerId: '3',
  cloudFastSpeakerId: '3',
  cloudFastApiKey: '',
}

const toStoredString = (value: unknown, fallback: string) => {
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return fallback
}

const coerceTtsConfig = (raw: unknown): TtsUiConfig => {
  if (!raw || typeof raw !== 'object') return defaultTtsConfig
  const data = raw as Partial<Record<keyof TtsUiConfig, unknown>>
  return {
    localEndpoint: toStoredString(
      data.localEndpoint ?? (data as { endpoint?: unknown }).endpoint,
      defaultTtsConfig.localEndpoint
    ),
    localSpeakerId: toStoredString(
      data.localSpeakerId ?? (data as { speakerId?: unknown }).speakerId,
      defaultTtsConfig.localSpeakerId
    ),
    cloudSlowSpeakerId: toStoredString(
      data.cloudSlowSpeakerId ?? (data as { cloudSpeakerId?: unknown }).cloudSpeakerId,
      defaultTtsConfig.cloudSlowSpeakerId
    ),
    cloudFastSpeakerId: toStoredString(data.cloudFastSpeakerId, defaultTtsConfig.cloudFastSpeakerId),
    cloudFastApiKey: toStoredString(data.cloudFastApiKey, defaultTtsConfig.cloudFastApiKey),
  }
}

const persistTtsConfig = (config: TtsUiConfig) => {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(
      TTS_STORAGE_KEY,
      JSON.stringify({
        tts: config,
      })
    )
  } catch {
    // ignore storage errors
  }
}

const videoTypeManifestFile = 'video_types.json'

const isMotionType = (value: unknown): value is MotionType =>
  typeof value === 'string' && Object.prototype.hasOwnProperty.call(motionLabels, value)

const normalizeManifestKey = (value: string): string | null => {
  const normalized = value
    .trim()
    .replace(/\\/g, '/')
    .split('/')
    .filter(Boolean)
    .join('/')
    .toLowerCase()
  return normalized || null
}

const parseVideoTypesManifest = (text: string): Map<string, MotionType> => {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('video_types.json が正しい JSON ではありません')
  }

  const map = new Map<string, MotionType>()
  const addMapping = (fileName: unknown, typeValue: unknown) => {
    if (typeof fileName !== 'string' || !fileName.trim()) {
      throw new Error('video_types.json の各エントリには file プロパティが必要です')
    }
    if (!isMotionType(typeValue)) {
      throw new Error(`video_types.json に未対応の種別 "${String(typeValue)}" が指定されています (${fileName})`)
    }
    const normalizedPath = normalizeManifestKey(fileName)
    if (!normalizedPath) {
      throw new Error(`video_types.json のファイル名 "${fileName}" を解釈できません`)
    }
    map.set(normalizedPath, typeValue)
    const base = normalizedPath.split('/').pop()
    if (base && base !== normalizedPath) {
      map.set(base, typeValue)
    }
  }

  if (Array.isArray(parsed)) {
    for (const entry of parsed) {
      if (!entry || typeof entry !== 'object') {
        throw new Error('video_types.json の各エントリは { file, type } 形式で記述してください')
      }
      addMapping(
        (entry as { file?: unknown }).file,
        (entry as { type?: unknown }).type
      )
    }
    return map
  }

  if (parsed && typeof parsed === 'object') {
    const manifestObj = parsed as { [key: string]: unknown; videos?: unknown }
    if (Array.isArray(manifestObj.videos)) {
      for (const entry of manifestObj.videos) {
        if (!entry || typeof entry !== 'object') {
          throw new Error('video_types.json の videos 配列は { file, type } オブジェクトで構成してください')
        }
        addMapping(
          (entry as { file?: unknown }).file,
          (entry as { type?: unknown }).type
        )
      }
      return map
    }
    if (manifestObj.videos !== undefined) {
      throw new Error('video_types.json の videos プロパティは配列である必要があります')
    }
    for (const [fileName, typeValue] of Object.entries(manifestObj)) {
      addMapping(fileName, typeValue)
    }
    return map
  }

  throw new Error('video_types.json の形式が正しくありません')
}

const readVideoTypesManifest = async (entry: JSZip.JSZipObject) =>
  parseVideoTypesManifest(await entry.async('string'))

const lookupManifestType = (map: Map<string, MotionType>, entryName: string, derivedName: string) => {
  const normalizedEntry = normalizeManifestKey(entryName)
  if (normalizedEntry && map.has(normalizedEntry)) {
    return map.get(normalizedEntry)
  }
  const normalizedBase = normalizeManifestKey(derivedName)
  if (normalizedBase && map.has(normalizedBase)) {
    return map.get(normalizedBase)
  }
  return undefined
}

interface ClipCandidate {
  file: File
  typeHint?: MotionType
}

const isAudioFile = (file: File) =>
  file.type.startsWith('audio/') || /\.(wav|mp3|m4a|aac|ogg)$/i.test(file.name)

const videoExtensionPattern = /\.(mp4|webm|mov)$/i

const imageExtensionPattern = /\.(png|jpe?g|webp)$/i

const isVideoFile = (file: File) => file.type.startsWith('video/') || videoExtensionPattern.test(file.name)

const isSupportedImageFile = (file: File) => file.type.startsWith('image/') || imageExtensionPattern.test(file.name)

const isZipFile = (file: File) => file.type === 'application/zip' || /\.zip$/i.test(file.name)

const guessVideoMimeType = (name: string) => {
  const ext = name.split('.').pop()?.toLowerCase()
  switch (ext) {
    case 'mp4':
      return 'video/mp4'
    case 'webm':
      return 'video/webm'
    case 'mov':
      return 'video/quicktime'
    default:
      return 'video/mp4'
  }
}

const createId = () => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const buffer = new Uint8Array(16)
    crypto.getRandomValues(buffer)
    buffer[6] = (buffer[6] & 0x0f) | 0x40
    buffer[8] = (buffer[8] & 0x3f) | 0x80
    const hex = Array.from(buffer, (byte) => byte.toString(16).padStart(2, '0')).join('')
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
  }
  return `clip-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

const loadFfmpegConstructor = async (): Promise<new () => FFmpegInstance> => {
  const mod = await import('@ffmpeg/ffmpeg')
  if (mod && typeof mod === 'object') {
    if (typeof (mod as { FFmpeg?: unknown }).FFmpeg === 'function') {
      return (mod as { FFmpeg: new () => FFmpegInstance }).FFmpeg
    }
    if ('default' in mod) {
      const def = (mod as { default?: unknown }).default
      if (typeof def === 'function') {
        return def as new () => FFmpegInstance
      }
      if (def && typeof def === 'object' && typeof (def as { FFmpeg?: unknown }).FFmpeg === 'function') {
        return (def as { FFmpeg: new () => FFmpegInstance }).FFmpeg
      }
    }
  }
  throw new Error('FFmpeg の読み込みに失敗しました')
}

const extractZipVideos = async (files: File[]): Promise<ClipCandidate[]> => {
  if (!files.length) return []
  const { default: JSZipModule } = await import('jszip')
  const extracted: ClipCandidate[] = []
  for (const zipFile of files) {
    const zip = await JSZipModule.loadAsync(await zipFile.arrayBuffer())
    const manifestEntry = Object.values(zip.files).find(
      (entry) => !entry.dir && entry.name.split('/').pop()?.toLowerCase() === videoTypeManifestFile
    )
    const manifestMap = manifestEntry ? await readVideoTypesManifest(manifestEntry) : new Map<string, MotionType>()
    const entries = Object.values(zip.files).filter(
      (entry) => !entry.dir && videoExtensionPattern.test(entry.name)
    )
    for (const entry of entries) {
      const buffer = (await entry.async('arraybuffer')) as ArrayBuffer
      const baseNameSegments = entry.name.split('/').filter(Boolean)
      const baseName = baseNameSegments[baseNameSegments.length - 1] ?? entry.name
      const derivedName = baseName || `clip_${Date.now()}`
      const type = guessVideoMimeType(derivedName)
      const extractedFile = new File([buffer], derivedName, { type, lastModified: Date.now() })
      const typeHint = lookupManifestType(manifestMap, entry.name, derivedName)
      extracted.push({ file: extractedFile, typeHint })
    }
  }
  return extracted
}

function App() {
  const [audioFile, setAudioFile] = useState<File | null>(null)
  const [analysis, setAnalysis] = useState<AudioAnalysisResult | null>(null)
  const [analysisBusy, setAnalysisBusy] = useState(false)
  const [analysisError, setAnalysisError] = useState<string | null>(null)

  const [clips, setClips] = useState<ClipAsset[]>([])
  const clipUrls = useRef(new Set<string>())
  const [videoStatus, setVideoStatus] = useState<string | null>(null)
  const [videoError, setVideoError] = useState<string | null>(null)
  const [clipInputMode, setClipInputMode] = useState<ClipInputMode>(() => readStoredClipMode())
  const [imageGenOptions, setImageGenOptions] = useState<ImageGeneratorOptions>(() => readStoredImageGeneratorOptions())
  const [imageGenBusy, setImageGenBusy] = useState(false)
  const [imageGenStatus, setImageGenStatus] = useState<string | null>(null)
  const [imageGenError, setImageGenError] = useState<string | null>(null)
  const [imageGenResultIds, setImageGenResultIds] = useState<string[]>([])
  const [imageGenDownloadBusy, setImageGenDownloadBusy] = useState(false)
  const [mouthImages, setMouthImages] = useState<Record<MouthImageKind, MouthImageSlot>>(() => ({
    closed: createEmptyMouthImageSlot(),
    open: createEmptyMouthImageSlot(),
  }))
  const mouthImageUrls = useRef<Record<MouthImageKind, string | null>>({ closed: null, open: null })

  const [plan, setPlan] = useState<TimelinePlan | null>(null)
  const [planError, setPlanError] = useState<string | null>(null)

  const audioInputRef = useRef<HTMLInputElement | null>(null)
  const clipInputRef = useRef<HTMLInputElement | null>(null)
  const closedImageInputRef = useRef<HTMLInputElement | null>(null)
  const openImageInputRef = useRef<HTMLInputElement | null>(null)
  const mouthImageInputRefs: Record<MouthImageKind, typeof closedImageInputRef> = {
    closed: closedImageInputRef,
    open: openImageInputRef,
  }

  const [audioDragActive, setAudioDragActive] = useState(false)

  const ffmpegRef = useRef<FFmpegInstance | null>(null)
  const ffmpegReady = useRef<Promise<void> | null>(null)
  const logHandlerRef = useRef<((payload: { message: string }) => void) | null>(null)
  const [ffmpegLoaded, setFfmpegLoaded] = useState(false)

  const [renderBusy, setRenderBusy] = useState(false)
  const [renderStatus, setRenderStatus] = useState<string | null>(null)
  const [renderError, setRenderError] = useState<string | null>(null)
  const [outputUrl, setOutputUrl] = useState<string | null>(null)
  const [outputName, setOutputName] = useState<string>('animation.mp4')
const getInitialAudioMode = (): 'tts' | 'upload' => {
  if (typeof window === 'undefined') return 'tts'
  const stored = window.localStorage.getItem(AUDIO_MODE_KEY)
  return stored === 'upload' ? 'upload' : 'tts'
}

const getInitialTtsProvider = (): TtsProvider => {
  if (typeof window === 'undefined') return 'local'
  const stored = window.localStorage.getItem(TTS_PROVIDER_KEY)
  if (stored === 'local' || stored === 'cloudSlow' || stored === 'cloudFast') {
    return stored
  }
  return 'local'
}

const [audioSetupMode, setAudioSetupMode] = useState<'tts' | 'upload'>(() => getInitialAudioMode())
const [ttsProvider, setTtsProvider] = useState<TtsProvider>(() => getInitialTtsProvider())
  const [ttsText, setTtsText] = useState('')
  const [ttsBusy, setTtsBusy] = useState(false)
  const [ttsStatus, setTtsStatus] = useState<string | null>(null)
  const [ttsError, setTtsError] = useState<string | null>(null)
  const [ttsConfig, setTtsConfig] = useState<TtsUiConfig>(defaultTtsConfig)
  const [speakerOptions, setSpeakerOptions] = useState<VoicevoxSpeakerOption[] | null>(null)
  const [speakerLoading, setSpeakerLoading] = useState(false)
  const [speakerError, setSpeakerError] = useState<string | null>(null)
  const [pendingAutoRender, setPendingAutoRender] = useState(false)

  const applyTtsConfig = useCallback((updater: (prev: TtsUiConfig) => TtsUiConfig) => {
    setTtsConfig((prev) => {
      const next = updater(prev)
      if (next === prev) return prev
      persistTtsConfig(next)
      return next
    })
  }, [])

  const updateTtsConfig = (patch: Partial<TtsUiConfig>) => {
    applyTtsConfig((prev) => ({ ...prev, ...patch }))
  }

  const applyImageGenOptions = useCallback(
    (updater: (prev: ImageGeneratorOptions) => ImageGeneratorOptions) => {
      setImageGenOptions((prev) => {
        const next = updater(prev)
        if (next === prev) return prev
        persistImageGeneratorOptions(next)
        return next
      })
    },
    []
  )

  const updateImageGenOptions = (patch: Partial<ImageGeneratorOptions>) => {
    applyImageGenOptions((prev) => ({
      ...prev,
      ...patch,
    }))
  }

  const aspectWarning = useMemo(() => {
    const closed = mouthImages.closed
    const open = mouthImages.open
    if (!closed.width || !closed.height || !open.width || !open.height) return null
    if (!closed.height || !open.height) return null
    const closedRatio = closed.width / closed.height
    const openRatio = open.width / open.height
    if (!Number.isFinite(closedRatio) || !Number.isFinite(openRatio)) return null
    const diff = Math.abs(closedRatio - openRatio) / closedRatio
    if (diff > ASPECT_RATIO_WARNING_THRESHOLD) {
      return '2 枚の画像で縦横比が大きく異なるため、生成される動画がわずかに歪む可能性があります'
    }
    return null
  }, [
    mouthImages.closed.width,
    mouthImages.closed.height,
    mouthImages.open.width,
    mouthImages.open.height,
  ])

  const imagesReady = Boolean(
    mouthImages.closed.file &&
    mouthImages.open.file &&
    mouthImages.closed.width &&
    mouthImages.closed.height &&
    mouthImages.open.width &&
    mouthImages.open.height
  )

  const hasAutoGeneratedClips = useMemo(() => clips.some((clip) => clip.origin === 'imageGenerator'), [clips])

  const autoGeneratedClipCount = useMemo(
    () => clips.filter((clip) => clip.origin === 'imageGenerator').length,
    [clips]
  )

  const latestGeneratedClips = useMemo(
    () => clips.filter((clip) => imageGenResultIds.includes(clip.id)),
    [clips, imageGenResultIds]
  )

  const canGenerateFromImages = Boolean(!imageGenBusy && !imageGenDownloadBusy && imagesReady)

  const canDownloadAutoGeneratedClips = Boolean(
    hasAutoGeneratedClips && !imageGenBusy && !imageGenDownloadBusy
  )

  const loadSpeakerOptions = useCallback(
    async (provider: TtsProvider) => {
      if (provider === 'local') {
        setSpeakerOptions(null)
        setSpeakerError(null)
        return
      }
      if (provider === 'cloudFast' && !ttsConfig.cloudFastApiKey.trim()) {
        setSpeakerOptions(null)
        setSpeakerError('VOICEVOX API（高速）の API キーを入力してください')
        return
      }
      setSpeakerLoading(true)
      setSpeakerOptions(null)
      setSpeakerError(null)
      try {
        const list = await fetchVoicevoxCloudSpeakers(ttsConfig.cloudFastApiKey.trim() || undefined)
        const options = list.flatMap((speaker) =>
          speaker.styles
            .filter((style) => !style.type || style.type === 'talk')
            .map((style) => ({
              id: style.id,
              label: `${speaker.name}（${style.name}）`,
            }))
        )
        setSpeakerOptions(options)
        if (options.length) {
          applyTtsConfig((prev) => {
            if (options.some((opt) => String(opt.id) === prev.cloudFastSpeakerId)) {
              return prev
            }
            return { ...prev, cloudFastSpeakerId: String(options[0].id) }
          })
        }
      } catch (error) {
        setSpeakerOptions(null)
        setSpeakerError(error instanceof Error ? error.message : '話者一覧の取得に失敗しました')
      } finally {
        setSpeakerLoading(false)
      }
    },
    [ttsConfig.cloudFastApiKey, applyTtsConfig]
  )

  const handleRefreshSpeakers = () => {
    if (ttsProvider === 'cloudFast' && !ttsConfig.cloudFastApiKey.trim()) {
      setSpeakerError('VOICEVOX API（高速）の API キーを入力してください')
      return
    }
    void loadSpeakerOptions(ttsProvider)
  }

  useEffect(
    () => () => {
      clipUrls.current.forEach((url) => URL.revokeObjectURL(url))
    },
    []
  )

  useEffect(
    () => () => {
      mouthImageOrder.forEach((kind) => {
        const url = mouthImageUrls.current[kind]
        if (url) URL.revokeObjectURL(url)
      })
    },
    []
  )

  useEffect(() => {
    return () => {
      if (ffmpegRef.current && logHandlerRef.current) {
        ffmpegRef.current.off('log', logHandlerRef.current)
      }
    }
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined') return
    try {
      const raw = window.localStorage.getItem(TTS_STORAGE_KEY)
      if (!raw) return
      const parsed = JSON.parse(raw) as { tts?: unknown }
      if (parsed.tts) {
        const next = coerceTtsConfig(parsed.tts)
        setTtsConfig(next)
      }
    } catch {
      // 破損した JSON は無視
    }
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined') return
    try {
      window.localStorage.setItem(AUDIO_MODE_KEY, audioSetupMode)
    } catch {
      // ignore
    }
  }, [audioSetupMode])

  useEffect(() => {
    if (typeof window === 'undefined') return
    try {
      window.localStorage.setItem(TTS_PROVIDER_KEY, ttsProvider)
    } catch {
      // ignore
    }
  }, [ttsProvider])

  useEffect(() => {
    if (typeof window === 'undefined') return
    try {
      window.localStorage.setItem(CLIP_MODE_STORAGE_KEY, clipInputMode)
    } catch {
      // ignore
    }
  }, [clipInputMode])

  useEffect(() => {
    if (ttsProvider === 'local') {
      setSpeakerOptions(null)
      setSpeakerError(null)
      return
    }
    if (ttsProvider === 'cloudFast' && !ttsConfig.cloudFastApiKey.trim()) {
      setSpeakerOptions(null)
      setSpeakerError('VOICEVOX API（高速）の API キーを入力してください')
      return
    }
    void loadSpeakerOptions(ttsProvider)
  }, [ttsProvider, ttsConfig.cloudFastApiKey, loadSpeakerOptions])

  useEffect(() => {
    if (!analysis || !clips.length) {
      setPlan(null)
      setPlanError(null)
      return
    }
    try {
      const nextPlan = buildTimelinePlan(analysis.segments, clips)
      setPlan(nextPlan)
      setPlanError(null)
    } catch (error) {
      setPlan(null)
      setPlanError(error instanceof Error ? error.message : String(error))
    }
  }, [analysis, clips])

  useEffect(() => {
    setImageGenResultIds((prev) => prev.filter((id) => clips.some((clip) => clip.id === id)))
  }, [clips])

  const ensureFfmpeg = useCallback(async (): Promise<FFmpegInstance> => {
    if (!ffmpegRef.current) {
      const FFmpegConstructor = await loadFfmpegConstructor()
      ffmpegRef.current = new FFmpegConstructor()
      const handleLog = ({ message }: { message: string }) => {
        console.info('[ffmpeg]', message)
      }
      ffmpegRef.current.on('log', handleLog)
      logHandlerRef.current = handleLog
    }

    if (!ffmpegLoaded) {
      if (!ffmpegReady.current) {
        ffmpegReady.current = (async () => {
          if (!ffmpegRef.current) throw new Error('FFmpeg not available')
          await ffmpegRef.current.load()
          setFfmpegLoaded(true)
        })().catch((error) => {
          ffmpegReady.current = null
          throw error
        })
      }
      await ffmpegReady.current
    }

    if (!ffmpegRef.current) throw new Error('FFmpeg not available')
    return ffmpegRef.current
  }, [ffmpegLoaded])

  const resetOutput = useCallback(() => {
    if (outputUrl) URL.revokeObjectURL(outputUrl)
    setOutputUrl(null)
  }, [outputUrl])

  const processAudioFile = async (file: File) => {
    setAudioFile(file)
    setAnalysis(null)
    setAnalysisError(null)
    setAnalysisBusy(true)
    resetOutput()
    try {
      const result = await analyzeAudio(file)
      setAnalysis(result)
    } catch (error) {
      setAnalysisError(error instanceof Error ? error.message : '音声解析に失敗しました')
    } finally {
      setAnalysisBusy(false)
    }
  }

  const handleTtsGenerate = async (options?: { autoRender?: boolean }) => {
    if (!ttsText.trim()) {
      setTtsError('読み上げるテキストを入力してください')
      return
    }
    if (ttsProvider === 'cloudFast' && !ttsConfig.cloudFastApiKey.trim()) {
      setTtsError('VOICEVOX API（高速）の API キーを入力してください')
      return
    }
    setTtsBusy(true)
    setTtsStatus(
      ttsProvider === 'local'
        ? 'VOICEVOX エンジンで音声を生成しています...'
        : ttsProvider === 'cloudSlow'
          ? 'VOICEVOX API（低速）で音声を生成しています...'
          : 'VOICEVOX API（高速）で音声を生成しています...'
    )
    setTtsError(null)
    try {
      const normalizedText = ttsText.trim()
      const speakerIdValue = (value: string, fallback: number) => {
        const parsed = Number(value)
        if (Number.isFinite(parsed) && parsed >= 0) return Math.floor(parsed)
        return fallback
      }
      let file: File
      if (ttsProvider === 'local') {
        file = await synthesizeVoicevox(normalizedText, {
          endpoint: ttsConfig.localEndpoint,
          speakerId: speakerIdValue(ttsConfig.localSpeakerId, 1),
        })
      } else if (ttsProvider === 'cloudSlow') {
        file = await synthesizeVoicevoxCloud(normalizedText, {
          speakerId: speakerIdValue(ttsConfig.cloudSlowSpeakerId, 1),
        })
      } else {
        file = await synthesizeVoicevoxFast(normalizedText, {
          speakerId: speakerIdValue(ttsConfig.cloudFastSpeakerId, 1),
          apiKey: ttsConfig.cloudFastApiKey.trim(),
        })
      }
      await processAudioFile(file)
      setTtsStatus(null)
      setPendingAutoRender(Boolean(options?.autoRender))
    } catch (error) {
      setTtsStatus(null)
      setTtsError(error instanceof Error ? error.message : '音声生成に失敗しました')
      setPendingAutoRender(false)
    } finally {
      setTtsBusy(false)
    }
  }

  const handleAudioChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    if (!isAudioFile(file)) {
      setAnalysisError('音声ファイルのみアップロードできます')
      return
    }
    void processAudioFile(file)
  }

  const handleAudioZoneClick = () => {
    audioInputRef.current?.click()
  }

  const handleAudioDragOver = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    setAudioDragActive(true)
  }

  const handleAudioDragLeave = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    const related = event.relatedTarget as Node | null
    if (!related || !event.currentTarget.contains(related)) {
      setAudioDragActive(false)
    }
  }

  const handleAudioDrop = async (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    setAudioDragActive(false)
    const file = event.dataTransfer.files?.[0]
    if (!file) return
    if (!isAudioFile(file)) {
      setAnalysisError('音声ファイルのみアップロードできます')
      return
    }
    await processAudioFile(file)
  }

  const updateMouthImageSlot = (kind: MouthImageKind, slot: MouthImageSlot) => {
    setMouthImages((prev) => {
      const prevUrl = mouthImageUrls.current[kind]
      const nextUrl = slot.previewUrl ?? null
      if (prevUrl && prevUrl !== nextUrl) {
        URL.revokeObjectURL(prevUrl)
      }
      mouthImageUrls.current[kind] = nextUrl
      const nextSlot: MouthImageSlot = {
        file: slot.file ?? null,
        previewUrl: nextUrl,
        width: slot.width ?? null,
        height: slot.height ?? null,
      }
      if (
        prev[kind].file === nextSlot.file &&
        prev[kind].previewUrl === nextSlot.previewUrl &&
        prev[kind].width === nextSlot.width &&
        prev[kind].height === nextSlot.height
      ) {
        return prev
      }
      return {
        ...prev,
        [kind]: nextSlot,
      }
    })
  }

  const resetMouthImages = () => {
    mouthImageOrder.forEach((kind) => clearMouthImage(kind))
  }

  const clearMouthImage = (kind: MouthImageKind) => {
    updateMouthImageSlot(kind, createEmptyMouthImageSlot())
  }

  const handleMouthImageSelection = async (kind: MouthImageKind, file: File | null) => {
    if (!file) {
      clearMouthImage(kind)
      return
    }
    if (!isSupportedImageFile(file)) {
      setImageGenError('PNG / JPEG / WebP の画像のみ利用できます')
      return
    }
    if (file.size > MAX_IMAGE_FILE_SIZE) {
      setImageGenError('画像サイズは 10MB 以下にしてください')
      return
    }
    try {
      const meta = await loadImagePreviewMetadata(file)
      if (meta.width > MAX_IMAGE_DIMENSION || meta.height > MAX_IMAGE_DIMENSION) {
        URL.revokeObjectURL(meta.url)
        setImageGenError(`画像の一辺は ${MAX_IMAGE_DIMENSION}px 以内にしてください`)
        return
      }
      updateMouthImageSlot(kind, {
        file,
        previewUrl: meta.url,
        width: meta.width,
        height: meta.height,
      })
      setImageGenError(null)
    } catch (error) {
      setImageGenError(error instanceof Error ? error.message : '画像の読み込みに失敗しました')
    }
  }

  const handleMouthImageInputChange = (kind: MouthImageKind, event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0] ?? null
    event.target.value = ''
    void handleMouthImageSelection(kind, file)
  }

  const handleMouthImageDrop = (kind: MouthImageKind, event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    const file = event.dataTransfer?.files?.[0]
    if (!file) return
    void handleMouthImageSelection(kind, file)
  }

  const handleMouthImageDragOver = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
  }

  const handleMouthImageZoneClick = (kind: MouthImageKind) => {
    mouthImageInputRefs[kind].current?.click()
  }

  const handleClipModeSwitch = (mode: ClipInputMode) => {
    if (mode === clipInputMode) return
    if ((imageGenBusy || imageGenDownloadBusy) && clipInputMode === 'image') return
    setClipInputMode(mode)
  }

  const handleFrameDurationInput = (raw: string) => {
    const value = Number(raw)
    if (!Number.isFinite(value)) return
    const clamped = Math.min(MAX_FRAME_DURATION, Math.max(MIN_FRAME_DURATION, value))
    updateImageGenOptions({ frameDuration: clamped })
  }

  const handleRemoveAutoGeneratedClips = () => {
    if (!hasAutoGeneratedClips) return
    resetOutput()
    setClips((prev) => {
      const survivors: ClipAsset[] = []
      for (const clip of prev) {
        if (clip.origin === 'imageGenerator') {
          URL.revokeObjectURL(clip.url)
          clipUrls.current.delete(clip.url)
          continue
        }
        survivors.push(clip)
      }
      return survivors
    })
    setImageGenResultIds([])
  }

  const loadClipAsset = useCallback(
    async (file: File, type: MotionType, options?: { origin?: ClipOrigin }): Promise<ClipAsset> => {
      const url = URL.createObjectURL(file)
      clipUrls.current.add(url)
      try {
        const duration = await readVideoDuration(url)
        return {
          id: createId(),
          file,
          url,
          name: file.name,
          duration: Number.isFinite(duration) && duration > 0 ? duration : 1,
          type,
          origin: options?.origin,
        }
      } catch (error) {
        URL.revokeObjectURL(url)
        clipUrls.current.delete(url)
        throw error
      }
    },
    []
  )

  const processClipFiles = async (files: File[]) => {
    const zipFiles = files.filter(isZipFile)
    const videoFiles = files.filter((file) => !isZipFile(file) && isVideoFile(file))
    if (!zipFiles.length && !videoFiles.length) {
      setVideoError('動画または ZIP ファイルのみアップロードできます')
      return
    }
    setVideoStatus(zipFiles.length ? 'ZIP を展開中...' : '動画メタデータを読み込み中...')
    setVideoError(null)
    resetOutput()
    try {
      const extractedVideos = zipFiles.length ? await extractZipVideos(zipFiles) : []
      const directVideos: ClipCandidate[] = videoFiles.map((file) => ({ file }))
      const allVideos: ClipCandidate[] = [...directVideos, ...extractedVideos]
      if (!allVideos.length) {
        setVideoError('ZIP 内に動画ファイルが見つかりませんでした')
        return
      }
      if (zipFiles.length) {
        setVideoStatus('動画メタデータを読み込み中...')
      }
      const assets: ClipAsset[] = []
      for (const { file, typeHint } of allVideos) {
        // 読み込みは順番に実施し、ブラウザのデコーダ負荷を抑える
        // （大量の動画を同時に処理するとタブがフリーズしやすいため）。
        const asset = await loadClipAsset(file, typeHint ?? 'idle', { origin: 'upload' })
        assets.push(asset)
      }
      setClips((prev) => [...prev, ...assets])
    } catch (error) {
      setVideoError(error instanceof Error ? error.message : '動画の読み込みに失敗しました')
    } finally {
      setVideoStatus(null)
    }
  }

  const handleGenerateFromImages = useCallback(async () => {
    if (!mouthImages.closed.file || !mouthImages.open.file) {
      setImageGenError('口を閉じた画像と開いた画像を両方アップロードしてください')
      return
    }
    if (
      !mouthImages.closed.width ||
      !mouthImages.closed.height ||
      !mouthImages.open.width ||
      !mouthImages.open.height
    ) {
      setImageGenError('画像の読み込み結果を確認できませんでした')
      return
    }
    const outputWidth = Math.max(mouthImages.closed.width, mouthImages.open.width)
    const outputHeight = Math.max(mouthImages.closed.height, mouthImages.open.height)
    const cleanupTargets: string[] = []
    setImageGenBusy(true)
    setImageGenStatus('FFmpeg を初期化しています...')
    setImageGenError(null)
    resetOutput()
    const frameDuration = Math.min(
      MAX_FRAME_DURATION,
      Math.max(MIN_FRAME_DURATION, imageGenOptions.frameDuration)
    )
    try {
      const ffmpeg = await ensureFfmpeg()
      setImageGenStatus('画像を整形しています...')
      const closedBytes = await rasterizeImageToPng(
        mouthImages.closed.file,
        outputWidth,
        outputHeight,
        IMAGE_CANVAS_BACKGROUND
      )
      const openBytes = await rasterizeImageToPng(
        mouthImages.open.file,
        outputWidth,
        outputHeight,
        IMAGE_CANVAS_BACKGROUND
      )
      await ffmpeg.writeFile(mouthImageFilenames.closed, closedBytes)
      await ffmpeg.writeFile(mouthImageFilenames.open, openBytes)
      cleanupTargets.push(mouthImageFilenames.closed, mouthImageFilenames.open)

      const codecPreset = defaultCodecPreset
      const generatedAssets: ClipAsset[] = []
      for (const type of clipGenerationOrder) {
        const recipe = clipFrameRecipes[type]
        if (!recipe) continue
        setImageGenStatus(`${motionLabels[type]} を生成しています...`)
        const outputName = `autogen_${type}.${codecPreset.extension}`
        try {
          await ffmpeg.deleteFile(outputName)
        } catch {
          // ignore residual files
        }
        const videoData = await generateMotionClipVideo(
          ffmpeg,
          recipe,
          frameDuration,
          outputName,
          codecPreset
        )
        cleanupTargets.push(outputName)
        const file = new File([videoData as unknown as BlobPart], `autogen-${type}.${codecPreset.extension}`, {
          type: codecPreset.mimeType,
          lastModified: Date.now(),
        })
        const asset = await loadClipAsset(file, type, { origin: 'imageGenerator' })
        generatedAssets.push(asset)
      }

      setClips((prev) => {
        const filtered: ClipAsset[] = []
        for (const clip of prev) {
          if (clip.origin === 'imageGenerator' && clipGenerationOrder.includes(clip.type)) {
            URL.revokeObjectURL(clip.url)
            clipUrls.current.delete(clip.url)
            continue
          }
          filtered.push(clip)
        }
        return [...filtered, ...generatedAssets]
      })
      setImageGenResultIds(generatedAssets.map((clip) => clip.id))
      setImageGenStatus('クリップを追加しました')
    } catch (error) {
      setImageGenError(error instanceof Error ? error.message : '画像から動画の生成に失敗しました')
      setImageGenResultIds([])
    } finally {
      const ffmpeg = ffmpegRef.current
      if (ffmpeg) {
        for (const target of cleanupTargets) {
          try {
            await ffmpeg.deleteFile(target)
          } catch {
            // ignore cleanup errors
          }
        }
      }
      setImageGenBusy(false)
    }
  }, [
    mouthImages.closed.file,
    mouthImages.closed.width,
    mouthImages.closed.height,
    mouthImages.open.file,
    mouthImages.open.width,
    mouthImages.open.height,
    imageGenOptions.frameDuration,
    ensureFfmpeg,
    loadClipAsset,
  ])

  const handleDownloadAutoGeneratedClips = useCallback(async () => {
    const autoClips = clips.filter((clip) => clip.origin === 'imageGenerator')
    if (!autoClips.length) return
    setImageGenDownloadBusy(true)
    setImageGenStatus('ZIP を作成しています...')
    setImageGenError(null)
    try {
      const { default: JSZipModule } = await import('jszip')
      const zip = new JSZipModule()
      for (const clip of autoClips) {
        zip.file(clip.file.name, await clip.file.arrayBuffer())
      }
      const manifest = {
        videos: autoClips.map((clip) => ({ file: clip.file.name, type: clip.type })),
      }
      zip.file(videoTypeManifestFile, JSON.stringify(manifest, null, 2))
      const blob = await zip.generateAsync({ type: 'blob' })
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').replace('Z', '')
      link.download = `autogen-motions-${timestamp}.zip`
      document.body.appendChild(link)
      link.click()
      document.body.removeChild(link)
      URL.revokeObjectURL(url)
      setImageGenStatus('ZIP をダウンロードしました')
    } catch (error) {
      setImageGenError(error instanceof Error ? error.message : 'ZIP の作成に失敗しました')
    } finally {
      setImageGenDownloadBusy(false)
    }
  }, [clips])

  const handleClipChange = (event: ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files ? Array.from(event.target.files) : []
    event.target.value = ''
    if (!files.length) return
    void processClipFiles(files)
  }

  const handleClipZoneClick = () => {
    clipInputRef.current?.click()
  }

  const handleClipDragOver = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
  }

  const handleClipDrop = async (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    const files = event.dataTransfer?.files ? Array.from(event.dataTransfer.files) : []
    if (!files.length) return
    await processClipFiles(files)
  }

  const updateClipType = (id: string, type: MotionType) => {
    resetOutput()
    setClips((prev) => prev.map((clip) => (clip.id === id ? { ...clip, type } : clip)))
  }

  const removeClip = (id: string) => {
    resetOutput()
    setClips((prev) => {
      const target = prev.find((clip) => clip.id === id)
      if (target) {
        URL.revokeObjectURL(target.url)
        clipUrls.current.delete(target.url)
      }
      return prev.filter((clip) => clip.id !== id)
    })
  }

  const handleRender = useCallback(async () => {
    if (!plan || !analysis) return
    setRenderBusy(true)
    setRenderStatus('FFmpeg を初期化しています...')
    setRenderError(null)
    const cleanupTargets: string[] = []
    let ffmpeg: FFmpegInstance | null = null
    try {
      ffmpeg = await ensureFfmpeg()
      const { fetchFile } = await import('@ffmpeg/util')

      setRenderStatus('音声トラックを整列しています...')
      const alignedBuffer = buildAlignedAudioBuffer(analysis.buffer, plan.talkPlans, plan.totalDuration)
      const wavBytes = audioBufferToWav(alignedBuffer)
      await ffmpeg.writeFile('aligned.wav', wavBytes)
      cleanupTargets.push('aligned.wav')

      setRenderStatus('動画クリップを準備しています...')
      const concatLines: string[] = []
      for (let i = 0; i < plan.placements.length; i++) {
        const filename = `clip_${i}.mp4`
        await ffmpeg.writeFile(filename, await fetchFile(plan.placements[i].clip.file))
        concatLines.push(`file '${filename}'`)
        cleanupTargets.push(filename)
      }
      await ffmpeg.writeFile('concat.txt', concatLines.join('\n'))
      cleanupTargets.push('concat.txt')

      setRenderStatus('エンコード中...')
      await ffmpeg.exec([
        '-f',
        'concat',
        '-safe',
        '0',
        '-i',
        'concat.txt',
        '-i',
        'aligned.wav',
        '-c:v',
        'copy',
        '-c:a',
        'aac',
        '-shortest',
        'output.mp4',
      ])
      const outputData = await ffmpeg.readFile('output.mp4')
      if (typeof outputData === 'string') {
        throw new Error('Unexpected text output when reading rendered video')
      }
      const videoBuffer = outputData.buffer.slice(
        outputData.byteOffset,
        outputData.byteOffset + outputData.byteLength
      ) as ArrayBuffer
      const blob = new Blob([videoBuffer], { type: 'video/mp4' })
      const url = URL.createObjectURL(blob)
      resetOutput()
      const timestamp = new Date()
        .toISOString()
        .replace(/[:.]/g, '-')
        .replace('T', '_')
        .replace('Z', '')
      const fileName = `animation-${timestamp}.mp4`
      setOutputUrl(url)
      setOutputName(fileName)
      cleanupTargets.push('output.mp4')
      setRenderStatus('完了しました')
    } catch (error) {
      setRenderError(error instanceof Error ? error.message : 'レンダリングに失敗しました')
    } finally {
      if (ffmpeg) {
        for (const target of cleanupTargets) {
          try {
            await ffmpeg.deleteFile(target)
          } catch {
            // virtual FS cleanup best-effort
          }
        }
      }
      setRenderBusy(false)
    }
  }, [analysis, plan, resetOutput, ensureFfmpeg])

  useEffect(() => {
    if (!pendingAutoRender) return
    if (analysisBusy || renderBusy || !analysis || !plan) return
    setPendingAutoRender(false)
    void handleRender()
  }, [pendingAutoRender, analysis, plan, analysisBusy, renderBusy, handleRender])

  return (
    <div className="app">
      <header>
        <div>
          <h1>Animation Streamer Builder</h1>
          <p className="lede">
            音声のボリュームから発話状態を検出し、待機/遷移/発話(大/小)モーション動画を組み合わせて 1 キャラクターの連続発話
            MP4 を生成します。
          </p>
        </div>
      </header>

      <section className="panel">
        <div className="panel-header">
          <div>
            <h2>1. モーションクリップ</h2>
            <p>待機/遷移/発話(大/小)の各カテゴリに最低 1 本ずつ登録してください。</p>
          </div>
        </div>
        <div className="clip-mode-switch">
          <button
            type="button"
            className={`clip-mode-button ${clipInputMode === 'upload' ? 'is-active' : ''}`}
            onClick={() => handleClipModeSwitch('upload')}
            disabled={imageGenBusy}
          >
            動画をアップロード
          </button>
          <button
            type="button"
            className={`clip-mode-button ${clipInputMode === 'image' ? 'is-active' : ''}`}
            onClick={() => handleClipModeSwitch('image')}
            disabled={imageGenBusy}
          >
            画像から生成
          </button>
        </div>

        {clipInputMode === 'upload' ? (
          <>
            {videoError && <p className="status error">{videoError}</p>}
            {videoStatus && <p className="status">{videoStatus}</p>}
            <div
              className="dropzone small central-drop"
              onClick={handleClipZoneClick}
              onDragOver={handleClipDragOver}
              onDrop={handleClipDrop}
            >
              <p className="dropzone-title">動画をまとめてドラッグ＆ドロップ</p>
              <p className="dropzone-sub">またはクリックして追加（ZIP で一括アップロードも可能／あとでカテゴリを割り当て）</p>
              <input
                ref={clipInputRef}
                type="file"
                accept="video/mp4,video/webm,video/quicktime,application/zip,.zip"
                multiple
                hidden
                onChange={handleClipChange}
              />
            </div>
          </>
        ) : (
          <div className="image-generator">
            {imageGenError && <p className="status error">{imageGenError}</p>}
            {imageGenStatus && <p className="status">{imageGenStatus}</p>}
            <p className="image-gen-tip">口の開閉 2 枚の画像から idle / speech 系のモーション動画をまとめて作成できます。</p>
            {aspectWarning && <p className="status warning">{aspectWarning}</p>}
            <div className="image-gen-grid">
              {mouthImageOrder.map((kind) => {
                const slot = mouthImages[kind]
                return (
                  <div key={kind} className={`image-slot ${slot.file ? 'has-image' : ''}`}>
                    <div
                      className="image-slot-drop"
                      onClick={() => handleMouthImageZoneClick(kind)}
                      onDragOver={handleMouthImageDragOver}
                      onDrop={(event) => handleMouthImageDrop(kind, event)}
                    >
                      {slot.previewUrl ? (
                        <img src={slot.previewUrl} alt={mouthImageLabels[kind]} />
                      ) : (
                        <div className="image-slot-placeholder">
                          <p>{mouthImageLabels[kind]}</p>
                          <p className="muted">PNG/JPEG/WebP・最大 4096px / 10MB</p>
                        </div>
                      )}
                    </div>
                    <div className="image-slot-meta">
                      <span>
                        {slot.width && slot.height ? `${slot.width}×${slot.height}px` : '未読み込み'}
                      </span>
                      {slot.file ? (
                        <div className="image-slot-actions">
                          <button
                            type="button"
                            className="ghost"
                            onClick={() => mouthImageInputRefs[kind].current?.click()}
                            disabled={imageGenBusy}
                          >
                            差し替え
                          </button>
                          <button
                            type="button"
                            className="ghost"
                            onClick={() => clearMouthImage(kind)}
                            disabled={imageGenBusy}
                          >
                            削除
                          </button>
                        </div>
                      ) : (
                        <button
                          type="button"
                          className="ghost"
                          onClick={() => mouthImageInputRefs[kind].current?.click()}
                          disabled={imageGenBusy}
                        >
                          画像を選ぶ
                        </button>
                      )}
                    </div>
                    <input
                      ref={mouthImageInputRefs[kind]}
                      type="file"
                      accept={MOUTH_IMAGE_ACCEPT}
                      hidden
                      onChange={(event) => handleMouthImageInputChange(kind, event)}
                      disabled={imageGenBusy}
                    />
                  </div>
                )
              })}
            </div>

            <div className="image-gen-options">
              <label className="input-field">
                <span>1 フレームの長さ (秒)</span>
                <input
                  type="number"
                  min={MIN_FRAME_DURATION}
                  max={MAX_FRAME_DURATION}
                  step={0.01}
                  value={imageGenOptions.frameDuration}
                  onChange={(event) => handleFrameDurationInput(event.target.value)}
                  disabled={imageGenBusy}
                />
              </label>
              <p className="image-gen-hint">
                speechLoopLarge は speechLoopSmall と同じ映像です。元画像より小さい場合は白背景で余白を埋めます。
              </p>
            </div>

            <div className="image-gen-actions">
              <button
                type="button"
                className="primary-button"
                onClick={() => void handleGenerateFromImages()}
                disabled={!canGenerateFromImages}
              >
                画像からモーションクリップを生成
              </button>
              <button type="button" className="secondary-button" onClick={resetMouthImages} disabled={imageGenBusy}>
                画像をリセット
              </button>
              <button
                type="button"
                className="secondary-button"
                onClick={() => void handleDownloadAutoGeneratedClips()}
                disabled={!canDownloadAutoGeneratedClips}
              >
                モーションをダウンロード
              </button>
              <button
                type="button"
                className="ghost"
                onClick={handleRemoveAutoGeneratedClips}
                disabled={!hasAutoGeneratedClips || imageGenBusy || imageGenDownloadBusy}
              >
                自動生成クリップを削除
                {hasAutoGeneratedClips ? `（${autoGeneratedClipCount}）` : ''}
              </button>
            </div>

            {latestGeneratedClips.length > 0 && (
              <div className="image-gen-preview">
                <p>今回追加されたクリップ</p>
                <div className="image-gen-preview-grid">
                  {latestGeneratedClips.map((clip) => (
                    <div key={clip.id} className="image-gen-preview-card">
                      <strong>{motionLabels[clip.type]}</strong>
                      <video src={clip.url} autoPlay loop muted playsInline />
                      <span>{formatSeconds(clip.duration)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
        {clips.length === 0 ? (
          <p className="empty">動画がまだありません。複数ファイルをまとめて追加できます。</p>
        ) : (
          <div className="table-wrapper scrollable">
            <table>
              <thead>
                <tr>
                  <th>名前</th>
                  <th>長さ</th>
                  <th>種別</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {clips.map((clip) => (
                  <tr key={clip.id}>
                    <td>
                      <div className="clip-name-cell">
                        <span>{clip.name}</span>
                        {clip.origin === 'imageGenerator' && <span className="clip-tag">AutoGen</span>}
                      </div>
                    </td>
                    <td>{formatSeconds(clip.duration)}</td>
                    <td>
                      <select value={clip.type} onChange={(event) => updateClipType(clip.id, event.target.value as MotionType)}>
                        {Object.entries(motionLabels).map(([value, label]) => (
                          <option key={value} value={value}>
                            {label}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <button className="ghost" onClick={() => removeClip(clip.id)}>
                        削除
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="panel speech-panel">
        <div className="panel-header">
          <div>
            <h2>2. 音声準備</h2>
            <p>音声ファイルをアップロードするか、テキストから音声を生成します。</p>
          </div>
          <div className="panel-header-tags">
            {audioFile && <span className="file-pill">{audioFile.name}</span>}
          </div>
        </div>
        <div className="speech-mode-options">
          <label className={`speech-mode-option ${audioSetupMode === 'tts' ? 'is-active' : ''}`}>
            <input
              type="radio"
              name="audio-setup-mode"
              value="tts"
              checked={audioSetupMode === 'tts'}
              onChange={() => setAudioSetupMode('tts')}
            />
            <span>テキストから生成</span>
          </label>
          <label className={`speech-mode-option ${audioSetupMode === 'upload' ? 'is-active' : ''}`}>
            <input
              type="radio"
              name="audio-setup-mode"
              value="upload"
              checked={audioSetupMode === 'upload'}
              onChange={() => setAudioSetupMode('upload')}
            />
            <span>音声ファイルをアップロード</span>
          </label>
        </div>
        {audioSetupMode === 'tts' ? (
          <>
            <div className="tts-provider-switch">
              <button
                type="button"
                className={`tts-provider-button ${ttsProvider === 'local' ? 'is-active' : ''}`}
                onClick={() => setTtsProvider('local')}
                disabled={ttsBusy}
              >
                VOICEVOX エンジン
              </button>
              <button
                type="button"
                className={`tts-provider-button ${ttsProvider === 'cloudSlow' ? 'is-active' : ''}`}
                onClick={() => setTtsProvider('cloudSlow')}
                disabled={ttsBusy}
              >
                VOICEVOX API（低速）
              </button>
              <button
                type="button"
                className={`tts-provider-button ${ttsProvider === 'cloudFast' ? 'is-active' : ''}`}
                onClick={() => setTtsProvider('cloudFast')}
                disabled={ttsBusy}
              >
                VOICEVOX API（高速）
              </button>
            </div>
            {ttsProvider === 'local' ? (
              <>
                <label className="input-field">
                  <span>VOICEVOX API URL</span>
                  <input
                    type="text"
                    value={ttsConfig.localEndpoint}
                    onChange={(event) => updateTtsConfig({ localEndpoint: event.target.value })}
                    placeholder="http://localhost:50021"
                    disabled={ttsBusy}
                  />
                </label>
                <label className="input-field">
                  <span>話者 ID</span>
                  <input
                    type="number"
                    min="0"
                    step="1"
                    value={ttsConfig.localSpeakerId}
                    onChange={(event) => updateTtsConfig({ localSpeakerId: event.target.value })}
                    disabled={ttsBusy}
                  />
                </label>
              </>
            ) : ttsProvider === 'cloudSlow' ? (
              <>
                <p className="tts-tip">
                  WEB版 VOICEVOX API（低速）で音声を生成します。生成完了まで数秒～数十秒かかる場合があります。{' '}
                  <a href="https://voicevox.su-shiki.com/su-shikiapis/ttsquest/" target="_blank" rel="noreferrer">
                    https://voicevox.su-shiki.com/su-shikiapis/ttsquest/
                  </a>
                </p>
                <label className="input-field">
                  <span>話者 ID</span>
                  <input
                    type="number"
                    min="0"
                    step="1"
                    value={ttsConfig.cloudSlowSpeakerId}
                    onChange={(event) => updateTtsConfig({ cloudSlowSpeakerId: event.target.value })}
                    disabled={ttsBusy}
                  />
                </label>
              </>
            ) : (
              <>
                <p className="tts-tip">
                  WEB版 VOICEVOX API（高速）で音声を生成します。都度ポイントが消費されます。{' '}
                  <a href="https://voicevox.su-shiki.com/su-shikiapis/" target="_blank" rel="noreferrer">
                    https://voicevox.su-shiki.com/su-shikiapis/
                  </a>
                </p>
                <label className="input-field">
                  <span>API キー</span>
                  <input
                    type="password"
                    value={ttsConfig.cloudFastApiKey}
                    onChange={(event) => updateTtsConfig({ cloudFastApiKey: event.target.value })}
                    placeholder="例: G_7-xxxxxxxx"
                    disabled={ttsBusy}
                  />
                </label>
                <div className="speaker-row">
                  <label className="input-field">
                    <span>話者</span>
                    <select
                      value={ttsConfig.cloudFastSpeakerId}
                      onChange={(event) => updateTtsConfig({ cloudFastSpeakerId: event.target.value })}
                      disabled={
                        speakerLoading || !speakerOptions?.length || ttsBusy || !ttsConfig.cloudFastApiKey.trim()
                      }
                    >
                      {speakerOptions?.length ? (
                        speakerOptions.map((option) => (
                          <option key={option.id} value={option.id}>
                            {option.label}
                          </option>
                        ))
                      ) : (
                        <option value="" disabled>
                          {speakerLoading ? '話者を取得中...' : '話者一覧を読み込んでください'}
                        </option>
                      )}
                    </select>
                  </label>
                  <button
                    type="button"
                    className="refresh-button"
                    onClick={handleRefreshSpeakers}
                    disabled={speakerLoading || !ttsConfig.cloudFastApiKey.trim()}
                  >
                    {speakerLoading ? '更新中...' : '話者を更新'}
                  </button>
                </div>
                {speakerError && <p className="status error">{speakerError}</p>}
              </>
            )}
            <label className="input-field">
              <span>テキスト</span>
              <textarea
                className="tts-textarea"
                placeholder="おはようございます。今日もいい天気ですね。"
                value={ttsText}
                onChange={(event) => setTtsText(event.target.value)}
                disabled={ttsBusy}
              />
            </label>
            <div className="speech-actions">
              <button
                type="button"
                className="primary-button"
                onClick={() => handleTtsGenerate({ autoRender: true })}
                disabled={ttsBusy || !ttsText.trim() || !clips.length || renderBusy}
              >
                {ttsBusy ? '処理中...' : '音声生成＆動画作成'}
              </button>
              {outputUrl && (
                <a className="file-button download" href={outputUrl} download={outputName}>
                  MP4 をダウンロード
                </a>
              )}
            </div>
            {renderStatus && <p className="status">{renderStatus}</p>}
            {renderError && <p className="status error">{renderError}</p>}
            {ttsStatus && <p className="status">{ttsStatus}</p>}
            {ttsError && <p className="status error">{ttsError}</p>}
          </>
        ) : (
          <>
            <div
              className={`dropzone primary-drop ${audioDragActive ? 'is-dragging' : ''}`}
              onClick={handleAudioZoneClick}
              onDragOver={handleAudioDragOver}
              onDragLeave={handleAudioDragLeave}
              onDrop={handleAudioDrop}
            >
              <p className="dropzone-title">音声ファイルをここにドラッグ＆ドロップ</p>
              <p className="dropzone-sub">またはクリックして選択（WAV / MP3 など）</p>
              {audioFile ? (
                <p className="selected-file">選択中: {audioFile.name}</p>
              ) : (
                <p className="selected-file muted">まだ選択されていません</p>
              )}
              <input ref={audioInputRef} type="file" accept="audio/*" onChange={handleAudioChange} hidden />
            </div>
            <div className="speech-actions">
              <button
                type="button"
                className="primary-button"
                disabled={!plan || !analysis || renderBusy}
                onClick={handleRender}
              >
                {renderBusy ? 'レンダリング中...' : '動画を書き出す'}
              </button>
              {outputUrl && (
                <a className="file-button download" href={outputUrl} download={outputName}>
                  MP4 をダウンロード
                </a>
              )}
            </div>
            {renderStatus && <p className="status">{renderStatus}</p>}
            {renderError && <p className="status error">{renderError}</p>}
          </>
        )}
      </section>

      <section className="panel">
        <div className="panel-header">
          <div>
            <h2>3. 解析＆タイムライン</h2>
            <p>音声解析結果と生成されたタイムラインを確認します。</p>
          </div>
          {planError && <span className="status error">{planError}</span>}
        </div>
        {analysisBusy && <p className="status">音声を解析中...</p>}
        {analysisError && <p className="status error">{analysisError}</p>}
        {!analysis ? (
          <p className="empty">音声をセットすると解析結果が表示されます。</p>
        ) : (
          <>
            <div className="card-grid">
              <div className="card">
                <strong>長さ</strong>
                <span>{formatSeconds(analysis.buffer.duration)}</span>
              </div>
              <div className="card">
                <strong>セグメント数</strong>
                <span>{analysis.segments.length}</span>
              </div>
              <div className="card">
                <strong>発話閾値</strong>
                <span>{analysis.talkThreshold.toFixed(3)}</span>
              </div>
              <div className="card">
                <strong>サイレンス閾値</strong>
                <span>{analysis.silenceThreshold.toFixed(3)}</span>
              </div>
            </div>
            <div className="table-wrapper scrollable">
              <table>
                <thead>
                  <tr>
                    <th>種類</th>
                    <th>開始</th>
                    <th>長さ</th>
                  </tr>
                </thead>
                <tbody>
                  {analysis.segments.map((segment) => (
                    <tr key={segment.id}>
                      <td>{segment.kind === 'talk' ? '発話' : '待機'}</td>
                      <td>{formatSeconds(segment.start)}</td>
                      <td>{formatSeconds(segment.duration)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
        {!plan ? (
          <p className="empty">音声と動画をセットすると自動でプランが作成されます。</p>
        ) : (
          <>
            <div className="card-grid">
              <div className="card">
                <strong>全体長</strong>
                <span>{formatSeconds(plan.totalDuration)}</span>
              </div>
              <div className="card">
                <strong>クリップ数</strong>
                <span>{plan.placements.length}</span>
              </div>
              <div className="card">
                <strong>発話セグメント</strong>
                <span>{plan.talkPlans.length}</span>
              </div>
            </div>
            <div className="table-wrapper scrollable">
              <table>
                <thead>
                  <tr>
                    <th>#</th>
                    <th>開始</th>
                    <th>長さ</th>
                    <th>種別</th>
                    <th>ファイル</th>
                  </tr>
                </thead>
                <tbody>
                  {plan.placements.map((placement, index) => (
                    <tr key={`${placement.clip.id}-${index}`}>
                      <td>{index + 1}</td>
                      <td>{formatSeconds(placement.start)}</td>
                      <td>{formatSeconds(placement.clip.duration)}</td>
                      <td>
                        <span className={`badge badge-${placement.clip.type}`}>{motionLabels[placement.clip.type]}</span>
                      </td>
                      <td>{placement.clip.name}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {plan.talkPlans.length > 0 && (
              <div className="table-wrapper scrollable">
                <table>
                  <thead>
                    <tr>
                      <th>発話#</th>
                      <th>映像開始</th>
                      <th>音声開始</th>
                      <th>遅延</th>
                      <th>長さ</th>
                    </tr>
                  </thead>
                  <tbody>
                    {plan.talkPlans.map((talk, index) => {
                      const delay = talk.videoStart - talk.audioStart
                      return (
                        <tr key={talk.segmentId}>
                          <td>{index + 1}</td>
                          <td>{formatSeconds(talk.videoStart)}</td>
                          <td>{formatSeconds(talk.audioStart)}</td>
                          <td>{delay >= 0 ? `+${formatSeconds(delay)}` : formatSeconds(delay)}</td>
                          <td>{formatSeconds(talk.audioDuration)}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </section>
    </div>
  )
}

const readVideoDuration = (url: string) =>
  new Promise<number>((resolve, reject) => {
    const video = document.createElement('video')
    video.preload = 'metadata'
    video.src = url
    video.onloadedmetadata = () => {
      resolve(video.duration || 0)
      video.remove()
    }
    video.onerror = () => {
      video.remove()
      reject(new Error('メタデータの読み込みに失敗しました'))
    }
  })

const loadImagePreviewMetadata = (file: File) =>
  new Promise<{ url: string; width: number; height: number }>((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const image = new Image()
    image.onload = () => {
      resolve({ url, width: image.naturalWidth || image.width, height: image.naturalHeight || image.height })
    }
    image.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('画像の読み込みに失敗しました'))
    }
    image.src = url
  })

const loadImageElement = (file: File) =>
  new Promise<HTMLImageElement>((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const image = new Image()
    image.onload = () => {
      URL.revokeObjectURL(url)
      resolve(image)
    }
    image.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('画像の読み込みに失敗しました'))
    }
    image.src = url
  })

const rasterizeImageToPng = async (
  file: File,
  width: number,
  height: number,
  background: string
) => {
  const image = await loadImageElement(file)
  const sourceWidth = image.naturalWidth || image.width
  const sourceHeight = image.naturalHeight || image.height
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas が利用できません')
  ctx.fillStyle = background
  ctx.fillRect(0, 0, width, height)
  const dx = Math.round((width - sourceWidth) / 2)
  const dy = Math.round((height - sourceHeight) / 2)
  ctx.drawImage(image, dx, dy, sourceWidth, sourceHeight)
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
  if (!blob) throw new Error('画像の変換に失敗しました')
  return new Uint8Array(await blob.arrayBuffer())
}

const generateMotionClipVideo = async (
  ffmpeg: FFmpegInstance,
  frames: MouthImageKind[],
  frameDuration: number,
  outputName: string,
  codecPreset: CodecPreset
) => {
  if (!frames.length) throw new Error('フレームが不足しています')
  const args: string[] = []
  const durationArg = frameDuration.toFixed(3)
  for (const frame of frames) {
    args.push('-loop', '1', '-t', durationArg, '-i', mouthImageFilenames[frame])
  }
  if (frames.length > 1) {
    args.push('-filter_complex', `concat=n=${frames.length}:v=1:a=0`)
  }
  args.push('-r', '30', '-an', ...codecPreset.outputArgs, outputName)
  await ffmpeg.exec(args)
  const data = await ffmpeg.readFile(outputName)
  if (typeof data === 'string') {
    throw new Error('生成した動画の読み込みに失敗しました')
  }
  return data
}

export default App
