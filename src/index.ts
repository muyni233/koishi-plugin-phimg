import { Context, Schema, h } from 'koishi'

export const inject = ['database', 'http']

declare module 'koishi' {
  interface Tables {
    phimg_config: GroupConfig
  }
}

const translationTable: Record<string, string> = {
  '；': ';', '：': ':', '，': ',', '（': '(', '）': ')',
  '【': '[', '】': ']', '《': '<', '》': '>', '？': '?',
  '！': '!', '。': '.', '、': ',',
}

function translateText(text: string) {
  if (!text) return text
  return text.split('').map(char => translationTable[char] || char).join('')
}

export interface Config {
  apiKey: string
  apiUrl: string
  defaultTags: string[]
  enabledByDefault: boolean
  useGlobalTagsByDefault: boolean
  filterId: number
  showErrorLog: boolean
}

export const Config: Schema<Config> = Schema.object({
  apiKey: Schema.string().description('Philomena API 密钥').role('secret').default(''),
  apiUrl: Schema.string().description('Philomena 图站域名').default('derpibooru.org'),
  defaultTags: Schema.array(String).description('全局默认标签').default(['safe']),
  enabledByDefault: Schema.boolean().description('新群聊默认启用搜图功能').default(true),
  useGlobalTagsByDefault: Schema.boolean().description('新群聊默认启用全局标签').default(true),
  filterId: Schema.number().description('搜索使用的 Filter ID (例如 100073)').default(100073),
  showErrorLog: Schema.boolean().description('是否在控制台输出搜图失败的日志').default(false),
})

interface GroupConfig {
  id: number
  groupId: string
  enabled: boolean
  useGlobalTags: boolean
  customTags: string[]
}

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

export function apply(ctx: Context, config: Config) {
  ctx.model.extend('phimg_config', {
    id: 'unsigned',
    groupId: 'string',
    enabled: 'boolean',
    useGlobalTags: 'boolean',
    customTags: 'list',
  }, {
    autoInc: true,
    primary: 'id',
    unique: ['groupId'],
  })

  const getGroupConfig = async (groupId: string): Promise<GroupConfig> => {
    let [groupConfig] = await ctx.database.get('phimg_config', { groupId })
    if (!groupConfig) {
      try {
        groupConfig = await ctx.database.create('phimg_config', {
          groupId,
          enabled: config.enabledByDefault,
          useGlobalTags: config.useGlobalTagsByDefault,
          customTags: []
        })
      } catch (e) {
        [groupConfig] = await ctx.database.get('phimg_config', { groupId })
      }
    }
    return groupConfig
  }

  const updateGroupConfig = async (groupId: string, data: Partial<GroupConfig>) => {
    await getGroupConfig(groupId)
    await ctx.database.set('phimg_config', { groupId }, data)
  }

  const makeRequest = async (method: 'images' | 'reverse', params: any) => {
    const host = config.apiUrl.replace(/^https?:\/\//, '').split('/')[0]
    const endpoint = `https://${host}/api/v1/json/search/${method}`
    
    const queryParams: any = {
      filter_id: config.filterId
    }
    
    if (params.key) {
      queryParams.key = params.key
      delete params.key
    }

    // 构建通用的伪装请求头
    const commonHeaders = {
      'User-Agent': BROWSER_UA,
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6',
      'Referer': `https://${host}/`,
      'Sec-Ch-Ua': '"Not/A)Brand";v="8", "Chromium";v="126", "Google Chrome";v="126"',
      'Sec-Ch-Ua-Mobile': '?0',
      'Sec-Ch-Ua-Platform': '"Windows"'
    }

    try {
      let responseData
      if (method === 'images') {
        responseData = await ctx.http.get(endpoint, {
          params: { ...queryParams, ...params },
          headers: commonHeaders
        })
      } else {
        const formBody = new URLSearchParams()
        for (const key in params) {
          if (params[key] !== undefined && params[key] !== null) {
            formBody.append(key, String(params[key]))
          }
        }
        responseData = await ctx.http.post(endpoint, formBody, {
          params: queryParams,
          headers: {
            ...commonHeaders,
            'Content-Type': 'application/x-www-form-urlencoded'
          }
        })
      }

      if (!responseData.images || responseData.images.length === 0) {
        throw new Error('未找到匹配的图片')
      }

      return responseData
    } catch (error) {
      const err = error as any
      if (config.showErrorLog) {
        ctx.logger('phimg').warn(`API Error: ${err?.message}`)
      }
      if (err?.response?.status === 404) throw new Error('未找到匹配的图片')
      if (err?.response?.status === 403) throw new Error('API请求被拒绝(403)')
      throw new Error(err?.message || 'API 请求失败')
    }
  }

  const VIDEO_TYPES = ['webm', 'mp4']

  const getMediaElement = (selected: any) => {
    if (!selected?.representations) return h.text('图片数据解析错误')
    const file = selected.representations.full
    const url = file.endsWith('.webm') ? selected.representations.medium : selected.representations.large
    const fileType = file.split('.').pop()?.toLowerCase() || ''
    if (VIDEO_TYPES.includes(fileType)) return h.video(url)
    return h.image(url)
  }

  const searchHelp = `用法: /搜图 [tags|distance]

用法说明:
  引用图片: 进行以图搜图 (默认距离 0.25)
  直接发图: 发送指令时附带图片进行以图搜图
  输入文本: 进行标签搜索

可选项:
  --tags             获取当前群聊内置标签列表
  --status           获取当前群聊的搜图功能状态
  --pp [num]         每页数量 (默认50)
  --p [num]          页码 (默认1)
  --sf [field]       排序字段 (默认score)
  --sd [desc|asc]    排序方向 (默认desc)
  --i [index]        选择结果索引 (默认随机)
—————
Powered by
Phimg for Koishi @ CyanFlow`

  const configHelp = `用法: /搜图-c [选项]

可选项:
  --add [tags]       添加标签
  --rm [tags]        删除标签
  --on               开启搜图
  --off              关闭搜图
  --onglobal         启用全局标签
  --offglobal        关闭全局标签
—————
Powered by
Phimg for Koishi @ CyanFlow`

  ctx.command('搜图 [...params]', '从图站搜索图片')
    .option('tags', '--tags')
    .option('status', '--status')
    .option('pp', '--pp <per_page:number>', { fallback: 50 })
    .option('p', '--p <page:number>', { fallback: 1 })
    .option('sf', '--sf <sf:string>', { fallback: 'score' })
    .option('sd', '--sd <sd:string>', { fallback: 'desc' })
    .option('i', '--i <index:number>', { fallback: -1 })
    .action(async ({ session, options }, ...paramsArray) => {
      if (!session?.guildId) return '搜图仅限群聊使用。'

      const opts = (options ?? {}) as {
        tags?: boolean
        status?: boolean
        pp?: number
        p?: number
        sf?: string
        sd?: string
        i?: number
      }
      const content = session.content ?? ''
      const rawParams = paramsArray.join(' ')
      // 更新帮助逻辑：如果没参数、没引用、当前消息也没图片、没选项，则显示帮助
      const hasImageInContent = !!(h.select(content, 'image')[0] || h.select(content, 'img')[0])
      if (!rawParams && !session.quote && !hasImageInContent && !opts.tags && !opts.status) return searchHelp

      const groupId = session.guildId
      const groupConfig = await getGroupConfig(groupId)

      if (opts.status) {
        return `当前群聊搜图功能状态：\n启用：${groupConfig.enabled}\n标签：${groupConfig.customTags.join(', ') || '无'}\n全局标签：${groupConfig.useGlobalTags ? '启用' : '禁用'}`
      }
      if (opts.tags) {
        return `当前群聊内置标签：${groupConfig.customTags.join(', ') || '无'}`
      }
      if (!groupConfig.enabled) {
        return '搜图未在本群开启，管理员请用 "搜图-c --on" 启动'
      }

      const paramsText = translateText(rawParams || '')
      const cleanParams = paramsText.replace(/<[^>]+>/g, '').trim()

      let imageUrl: string | undefined
      // 1. 优先检查引用消息中的图片
      if (session.quote) {
        const quoteContent = session.quote.content ?? ''
        const img = h.select(quoteContent, 'image')[0] || h.select(quoteContent, 'img')[0]
        if (img) imageUrl = img.attrs.url || img.attrs.src
      }
      // 2. 如果引用没图片，检查当前指令消息中是否附带了图片
      if (!imageUrl) {
        const img = h.select(content, 'image')[0] || h.select(content, 'img')[0]
        if (img) imageUrl = img.attrs.url || img.attrs.src
      }

      try {
        if (imageUrl) {
          let distance = 0.25
          if (cleanParams) {
            const parsed = Number(cleanParams)
            if (!isNaN(parsed)) {
              distance = parsed
            } else {
              return '图片搜索仅支持数字参数，表示相似度距离（distance）。'
            }
          }

          const queryParams: any = {
            key: config.apiKey,
            url: imageUrl,
            distance: distance
          }

          const data = await makeRequest('reverse', queryParams)
          const images = data.images

          if (images.length > 10) return `搜索到过多图片 (${images.length} 张)，请尝试减小距离参数。`
          if (images.length === 0) return '未找到匹配的图片'

          const result: h[] = [h('at', { id: session.userId }), h.text(`\ndistance: ${distance}\n`)]
          for (const img of images) {
            result.push(getMediaElement(img))
            result.push(h.text(`\nid: ${img.id} | score: ${img.score}\n`))
          }
          return result

        } else {
          const userTags = cleanParams ? cleanParams.split(/[,，]/).map(t => t.trim()).filter(t => t) : []
          const globalTags = groupConfig.useGlobalTags ? config.defaultTags : []
          const groupTags = groupConfig.customTags
          const allTags = Array.from(new Set([...groupTags, ...globalTags, ...userTags]))

          if (allTags.length === 0) return '请输入搜索标签。'

          const perPage = opts.pp ?? 50
          const queryParams: any = {
            q: allTags.join(', '),
            key: config.apiKey,
            per_page: perPage,
            page: opts.p ?? 1,
            sf: opts.sf ?? 'score',
            sd: opts.sd ?? 'desc',
          }

          const data = await makeRequest('images', queryParams)
          const images = data.images

          let index = opts.i ?? -1
          let additionalMsg = ''
          if (index < 0 || index >= images.length) {
            if (index >= 0) additionalMsg = `索引 ${index} 超出单页范围，已随机选择图片`
            index = Math.floor(Math.random() * images.length)
          }

          const selected = images[index]
          const result: h[] = [
            h('at', { id: session.userId }),
            getMediaElement(selected),
            h.text(`\nid: ${selected.id} | score: ${selected.score}`),
            h.text(`\ntags: ${queryParams.q}`),
          ]
          if (additionalMsg) result.push(h.text(`\n提示：${additionalMsg}`))
          return result
        }
      } catch (error) {
        return error instanceof Error ? error.message : String(error)
      }
    })

  const confirmOffGlobal = new Set<string>()

  ctx.command('搜图-c', '配置搜图功能', { authority: 3 })
    .option('on', '--on')
    .option('off', '--off')
    .option('onglobal', '--onglobal')
    .option('offglobal', '--offglobal')
    .option('add', '--add <tags:string>')
    .option('rm', '--rm <tags:string>')
    .action(async ({ session, options }) => {
      if (!session?.guildId) return '搜图配置仅限群聊使用。'
      const opts = (options ?? {}) as {
        on?: boolean
        off?: boolean
        onglobal?: boolean
        offglobal?: boolean
        add?: string
        rm?: string
      }
      if (Object.keys(opts).length === 0) return configHelp

      const groupId = session.guildId
      const groupConfig = await getGroupConfig(groupId)
      let response = ''

      if (opts.on && opts.off) return '不能同时开启和关闭搜图功能'

      if (opts.on) {
        await updateGroupConfig(groupId, { enabled: true })
        response += '搜图功能已在本群开启\n'
      } else if (opts.off) {
        await updateGroupConfig(groupId, { enabled: false })
        response += '搜图功能已在本群关闭\n'
      }

      if (opts.onglobal && opts.offglobal) return '不能同时开启和关闭全局标签'

      if (opts.onglobal) {
        await updateGroupConfig(groupId, { useGlobalTags: true })
        response += '全局标签已启用\n'
      } else if (opts.offglobal) {
        const confirmKey = `${session.guildId}-${session.userId}`
        if (!confirmOffGlobal.has(confirmKey)) {
          confirmOffGlobal.add(confirmKey)
          ctx.setTimeout(() => confirmOffGlobal.delete(confirmKey), 60000)
          return '关闭全局标签，机器人将会搜出非safe图片\n请自行承担风险，再次输入指令确认关闭'
        }
        confirmOffGlobal.delete(confirmKey)
        await updateGroupConfig(groupId, { useGlobalTags: false })
        response += '全局标签已禁用\n'
      }

      if (opts.add || opts.rm) {
        let newTags = [...groupConfig.customTags]
        if (opts.add) {
          const tagsToAdd = translateText(opts.add).split(/[,，]/).map(t => t.trim()).filter(t => t)
          newTags = [...new Set([...newTags, ...tagsToAdd])]
        }
        if (opts.rm) {
          const tagsToRm = translateText(opts.rm).split(/[,，]/).map(t => t.trim()).filter(t => t)
          newTags = newTags.filter(t => !tagsToRm.includes(t))
        }
        await updateGroupConfig(groupId, { customTags: newTags })
        response += `修改成功，本群标签现为: ${newTags.join(', ') || '无'}\n`
      }

      return response.trim()
    })
}
