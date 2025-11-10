const trimTrailingSlash = (value: string) => value.replace(/\/+$/, '')

const normalizeEndpoint = (value: string, label: string) => {
  const trimmed = value.trim()
  if (!trimmed) {
    throw new Error(`${label} を入力してください`)
  }
  return trimTrailingSlash(trimmed)
}

const assertBrowserApis = () => {
  if (typeof fetch !== 'function') throw new Error('fetch API が利用できません')
  if (typeof File !== 'function') throw new Error('File API が利用できません')
}

export interface VoicevoxRequestConfig {
  endpoint: string
  speakerId: number
}

export const synthesizeVoicevox = async (text: string, config: VoicevoxRequestConfig): Promise<File> => {
  assertBrowserApis()
  const normalizedText = text.trim()
  if (!normalizedText) throw new Error('読み上げテキストを入力してください')

  const endpoint = normalizeEndpoint(config.endpoint, 'VOICEVOX エンドポイント')
  const speakerId = Number.isFinite(config.speakerId) ? config.speakerId : 1
  const searchParams = new URLSearchParams({
    text: normalizedText,
    speaker: String(speakerId),
  })

  const queryResponse = await fetch(`${endpoint}/audio_query?${searchParams.toString()}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({}),
  })

  if (!queryResponse.ok) {
    const message = await safeReadText(queryResponse)
    throw new Error(`VOICEVOX audio_query が失敗しました (${queryResponse.status}): ${message}`)
  }

  const query = await queryResponse.json()
  const synthResponse = await fetch(`${endpoint}/synthesis?speaker=${speakerId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(query),
  })

  if (!synthResponse.ok) {
    const message = await safeReadText(synthResponse)
    throw new Error(`VOICEVOX synthesis が失敗しました (${synthResponse.status}): ${message}`)
  }

  const buffer = await synthResponse.arrayBuffer()
  return new File([buffer], `voicevox_${Date.now()}.wav`, {
    type: synthResponse.headers.get('content-type') || 'audio/wav',
    lastModified: Date.now(),
  })
}

const safeReadText = async (response: Response) => {
  try {
    return await response.text()
  } catch {
    return 'レスポンス本文を読み取れませんでした'
  }
}
