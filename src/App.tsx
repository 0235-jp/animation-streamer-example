import { useEffect, useRef, useState } from 'react'
import type { ChangeEvent, DragEvent } from 'react'
import type { FFmpeg as FFmpegInstance } from '@ffmpeg/ffmpeg'
import { fetchFile } from '@ffmpeg/util'
import './App.css'
import {
  analyzeAudio,
  audioBufferToWav,
  buildAlignedAudioBuffer,
  formatSeconds,
  type AudioAnalysisResult,
} from './lib/audio'
import { buildTimelinePlan } from './lib/timeline'
import type { ClipAsset, MotionType, TimelinePlan } from './types'

const motionLabels: Record<MotionType, string> = {
  idle: '待機',
  idleToSpeech: '待機→発話',
  speechLoop: '発話→発話',
  speechToIdle: '発話→待機',
}

const isAudioFile = (file: File) =>
  file.type.startsWith('audio/') || /\.(wav|mp3|m4a|aac|ogg)$/i.test(file.name)

const isVideoFile = (file: File) =>
  file.type.startsWith('video/') || /\.(mp4|webm|mov)$/i.test(file.name)

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

function App() {
  const [audioFile, setAudioFile] = useState<File | null>(null)
  const [analysis, setAnalysis] = useState<AudioAnalysisResult | null>(null)
  const [analysisBusy, setAnalysisBusy] = useState(false)
  const [analysisError, setAnalysisError] = useState<string | null>(null)

  const [clips, setClips] = useState<ClipAsset[]>([])
  const clipUrls = useRef(new Set<string>())
  const [videoStatus, setVideoStatus] = useState<string | null>(null)
  const [videoError, setVideoError] = useState<string | null>(null)

  const [plan, setPlan] = useState<TimelinePlan | null>(null)
  const [planError, setPlanError] = useState<string | null>(null)

  const audioInputRef = useRef<HTMLInputElement | null>(null)
  const clipInputRef = useRef<HTMLInputElement | null>(null)

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

  useEffect(
    () => () => {
      clipUrls.current.forEach((url) => URL.revokeObjectURL(url))
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

  const ensureFfmpeg = async (): Promise<FFmpegInstance> => {
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
  }

  const resetOutput = () => {
    if (outputUrl) URL.revokeObjectURL(outputUrl)
    setOutputUrl(null)
  }

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

  const loadClipAsset = async (file: File, type: MotionType): Promise<ClipAsset> => {
    const url = URL.createObjectURL(file)
    clipUrls.current.add(url)
    const duration = await readVideoDuration(url)
    return {
      id: createId(),
      file,
      url,
      name: file.name,
      duration: Number.isFinite(duration) && duration > 0 ? duration : 1,
      type,
    }
  }

  const processClipFiles = async (files: File[]) => {
    const videoFiles = files.filter(isVideoFile)
    if (!videoFiles.length) {
      setVideoError('動画ファイルのみアップロードできます')
      return
    }
    setVideoStatus('動画メタデータを読み込み中...')
    setVideoError(null)
    resetOutput()
    try {
      const assets = await Promise.all(videoFiles.map((file) => loadClipAsset(file, 'idle')))
      setClips((prev) => [...prev, ...assets])
    } catch (error) {
      setVideoError(error instanceof Error ? error.message : '動画の読み込みに失敗しました')
    } finally {
      setVideoStatus(null)
    }
  }

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

  const handleRender = async () => {
    if (!plan || !analysis) return
    setRenderBusy(true)
    setRenderStatus('FFmpeg を初期化しています...')
    setRenderError(null)
    try {
      const ffmpeg = await ensureFfmpeg()

      const cleanupTargets: string[] = []

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

      for (const target of cleanupTargets) {
        try {
          await ffmpeg.deleteFile(target)
        } catch {
          // virtual FS cleanup best-effort
        }
      }
    } catch (error) {
      setRenderError(error instanceof Error ? error.message : 'レンダリングに失敗しました')
    } finally {
      setRenderBusy(false)
    }
  }

  return (
    <div className="app">
      <header>
        <div>
          <p className="eyebrow">Cloudflare Pages ready</p>
          <h1>Animation Streamer Builder</h1>
          <p className="lede">
            音声のボリュームから発話状態を検出し、待機/遷移/発話モーション動画を組み合わせて 1 キャラクターの連続発話
            MP4 を生成します。
          </p>
        </div>
      </header>

      <section className="panel">
        <div className="panel-header">
          <div>
            <h2>1. 音声解析</h2>
            <p>80ms ウィンドウで RMS を測定し、ヒステリシスで発話／無音に分類します。</p>
          </div>
          {audioFile && <span className="tag">{audioFile.name}</span>}
        </div>
        {analysisBusy && <p className="status">音声を解析中...</p>}
        {analysisError && <p className="status error">{analysisError}</p>}
        <div
          className={`dropzone ${audioDragActive ? 'is-dragging' : ''}`}
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
        {analysis && (
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
        )}
        {analysis && (
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
        )}
      </section>

      <section className="panel">
        <div className="panel-header">
          <div>
            <h2>2. モーションクリップ</h2>
            <p>待機/遷移/発話の各カテゴリに最低 1 本ずつ登録してください。</p>
          </div>
          {videoStatus && <span className="status">{videoStatus}</span>}
        </div>
        {videoError && <p className="status error">{videoError}</p>}
        <div
          className="dropzone small central-drop"
          onClick={handleClipZoneClick}
          onDragOver={handleClipDragOver}
          onDrop={handleClipDrop}
        >
          <p className="dropzone-title">動画をまとめてドラッグ＆ドロップ</p>
          <p className="dropzone-sub">またはクリックして追加（あとでカテゴリを割り当て）</p>
          <input
            ref={clipInputRef}
            type="file"
            accept="video/mp4,video/webm,video/quicktime"
            multiple
            hidden
            onChange={handleClipChange}
          />
        </div>
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
                    <td>{clip.name}</td>
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

      <section className="panel">
        <div className="panel-header">
          <div>
            <h2>3. タイムライン構築</h2>
            <p>動画の長さを優先し、余剰分は次の発話開始を後ろにずらします。</p>
          </div>
          {planError && <span className="status error">{planError}</span>}
        </div>
        {!plan && <p className="empty">音声と動画をセットすると自動でプランが作成されます。</p>}
        {plan && (
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

      <section className="panel">
        <div className="panel-header">
          <div>
            <h2>4. レンダリング</h2>
            <p>ffmpeg.wasm でブラウザ内エンコード。Cloudflare Pages 上でも同じ挙動です。</p>
          </div>
          {renderStatus && <span className="status">{renderStatus}</span>}
        </div>
        {renderError && <p className="status error">{renderError}</p>}
      <div className="render-actions">
        <button disabled={!plan || !analysis || renderBusy} onClick={handleRender}>
          {renderBusy ? 'レンダリング中...' : '動画を書き出す'}
        </button>
        {outputUrl && (
          <a className="file-button download" href={outputUrl} download={outputName}>
            MP4 をダウンロード
          </a>
        )}
      </div>
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

export default App
