'use server'

import { createClient } from '@/utils/supabase/server'
import { revalidatePath } from 'next/cache'

export interface ScheduleItem {
  id?: string
  day_of_week: number
  period: number
  subject: string
  teacher?: string
  room?: string
  subject_group?: 'tu_nhien' | 'xa_hoi' | 'ngoai_ngu' | 'khac' | null
  isOverride?: boolean // true if from weekly
}

export async function getWeeklySchedule(weekStartDate: string): Promise<ScheduleItem[]> {
  const supabase = await createClient()

  const [templateRes, weeklyRes] = await Promise.all([
    supabase.from('class_schedule_template').select('*'),
    supabase.from('class_schedule_weekly').select('*').eq('week_start_date', weekStartDate)
  ])

  const templates = templateRes.data || []
  const weekly = weeklyRes.data || []

  const finalSchedule: ScheduleItem[] = []

  // Combine logic
  for (let d = 2; d <= 7; d++) {
    for (let p = 1; p <= 10; p++) {
      const wOverride = weekly.find(w => w.day_of_week === d && w.period === p)
      if (wOverride) {
        finalSchedule.push({ ...wOverride, isOverride: true })
      } else {
        const t = templates.find(t => t.day_of_week === d && t.period === p)
        if (t) {
          finalSchedule.push({ ...t, isOverride: false })
        }
      }
    }
  }

  return finalSchedule
}

export async function saveWeeklyOverride(
  weekStartDate: string,
  day: number,
  period: number,
  subject: string,
  teacher: string,
  room: string,
  subjectGroup: string,
  oldValue: any
) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Chưa đăng nhập')

  const { data: profile } = await supabase.from('profiles').select('role').eq('id', user.id).single()
  if (!profile || (profile.role !== 'admin' && profile.role !== 'gvcn' && !profile.role.includes('admin') && !profile.role.includes('gvcn'))) {
    throw new Error('Không có quyền thao tác')
  }

  const newValue = { subject, teacher, room, subject_group: subjectGroup }

  // 1. Upsert into weekly
  const { error: upsertErr } = await supabase.from('class_schedule_weekly').upsert({
    week_start_date: weekStartDate,
    day_of_week: day,
    period: period,
    subject,
    teacher: teacher || null,
    room: room || null,
    subject_group: subjectGroup || null
  }, { onConflict: 'week_start_date,day_of_week,period' })

  if (upsertErr) throw new Error('Lỗi lưu lịch: ' + upsertErr.message)

  // 2. Log change
  await supabase.from('schedule_change_log').insert({
    changed_by: user.id,
    week_start_date: weekStartDate,
    day_of_week: day,
    period,
    old_value: oldValue,
    new_value: newValue
  })

  // 3. Auto announcement
  const dayName = `Thứ ${day}`
  const oldSubj = oldValue?.subject || 'Trống'
  const newSubj = subject
  const title = `[Học tập] Đổi lịch: ${dayName} tiết ${period}`
  const content = `Đổi lịch: ${dayName} tiết ${period} chuyển từ ${oldSubj} sang ${newSubj}.`

  await supabase.from('announcements').insert({
    title,
    content,
    is_important: false,
    author_id: user.id
  })

  revalidatePath('/thoi-khoa-bieu')
}

export async function bulkSaveWeeklyOverrides(weekStartDate: string, items: ScheduleItem[]) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Chưa đăng nhập')

  const { data: profile } = await supabase.from('profiles').select('role').eq('id', user.id).single()
  if (!profile || (profile.role !== 'admin' && profile.role !== 'gvcn' && !profile.role.includes('admin') && !profile.role.includes('gvcn'))) {
    throw new Error('Không có quyền thao tác')
  }

  // delete existing for the week
  await supabase.from('class_schedule_weekly').delete().eq('week_start_date', weekStartDate)

  // insert new
  const rows = items.map(item => ({
    week_start_date: weekStartDate,
    day_of_week: item.day_of_week,
    period: item.period,
    subject: item.subject,
    teacher: item.teacher || null,
    room: item.room || null,
    subject_group: item.subject_group || null
  }))

  const { error } = await supabase.from('class_schedule_weekly').insert(rows)
  if (error) throw new Error('Lỗi lưu lịch: ' + error.message)

  // log
  await supabase.from('schedule_change_log').insert({
    changed_by: user.id,
    week_start_date: weekStartDate,
    day_of_week: 2, // arbitrary for bulk
    period: 1,
    old_value: { note: 'Bulk import from Excel' },
    new_value: { note: `Imported ${items.length} items` }
  })

  // auto announcement
  await supabase.from('announcements').insert({
    title: `[Học tập] Cập nhật thời khóa biểu tuần ${weekStartDate}`,
    content: `Lớp trưởng/GVCN vừa cập nhật lại thời khóa biểu mới cho tuần ${weekStartDate} từ file Excel. Các bạn vào xem chi tiết nhé.`,
    is_important: false,
    author_id: user.id
  })

  revalidatePath('/thoi-khoa-bieu')
}

export async function resetWeeklySchedule(weekStartDate: string) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Chưa đăng nhập')

  const { data: profile } = await supabase.from('profiles').select('role').eq('id', user.id).single()
  if (!profile || (profile.role !== 'admin' && profile.role !== 'gvcn' && !profile.role.includes('admin') && !profile.role.includes('gvcn'))) {
    throw new Error('Không có quyền thao tác')
  }

  const { error } = await supabase.from('class_schedule_weekly').delete().eq('week_start_date', weekStartDate)
  if (error) throw new Error('Lỗi reset lịch: ' + error.message)

  revalidatePath('/thoi-khoa-bieu')
}
export async function getSubjects() {
  const supabase = await createClient()
  const { data } = await supabase.from('subjects').select('*').order('name')
  
  if (!data || data.length === 0) {
    const defaultSubjects = [
      { name: 'Toán học', abbreviation: 'Toán', teacher_name: 'Cô Mai', teacher_phone: '' },
      { name: 'Toán học CĐ', abbreviation: 'Toán CĐ', teacher_name: 'Cô Mai', teacher_phone: '' },
      { name: 'Ngữ văn', abbreviation: 'Văn', teacher_name: 'Cô Hoa', teacher_phone: '' },
      { name: 'Ngữ văn CĐ', abbreviation: 'Văn CĐ', teacher_name: 'Cô Hoa', teacher_phone: '' },
      { name: 'Tiếng Anh', abbreviation: 'Anh', teacher_name: 'Cô Hương', teacher_phone: '' },
      { name: 'Vật lý', abbreviation: 'Lý', teacher_name: 'Cô Huệ', teacher_phone: '' },
      { name: 'Vật lý CĐ', abbreviation: 'Lý CĐ', teacher_name: 'Cô Huệ', teacher_phone: '' },
      { name: 'Lịch sử', abbreviation: 'Sử', teacher_name: 'Cô An', teacher_phone: '' },
      { name: 'Địa lý', abbreviation: 'Địa', teacher_name: 'Thầy Chiến', teacher_phone: '' },
      { name: 'Giáo dục KTPL', abbreviation: 'GDKTPL', teacher_name: 'Cô Chung', teacher_phone: '' },
      { name: 'Giáo dục Thể chất', abbreviation: 'GDTC', teacher_name: 'Thầy Đức', teacher_phone: '' },
      { name: 'Giáo dục Quốc phòng', abbreviation: 'GDQP', teacher_name: 'Cô Vân', teacher_phone: '' },
      { name: 'Giáo dục Địa phương', abbreviation: 'GDĐP', teacher_name: 'Cô Nhung', teacher_phone: '' },
      { name: 'Công nghệ Nông nghiệp', abbreviation: 'CNNN', teacher_name: 'Cô Nguyệt', teacher_phone: '' },
      { name: 'Sinh hoạt lớp', abbreviation: 'SHL', teacher_name: 'HĐTN2', teacher_phone: '' },
      { name: 'Chào cờ', abbreviation: 'Chào cờ', teacher_name: 'HĐTN1', teacher_phone: '' }
    ]
    await supabase.from('subjects').insert(defaultSubjects)
    const { data: newData } = await supabase.from('subjects').select('*').order('name')
    return newData || []
  }

  return data || []
}

export async function saveSubject(id: string | null, payload: any) {
  const supabase = await createClient()
  if (id) {
    const { error } = await supabase.from('subjects').update(payload).eq('id', id)
    if (error) throw new Error(error.message)
  } else {
    const { error } = await supabase.from('subjects').insert(payload)
    if (error) throw new Error(error.message)
  }
  revalidatePath('/thoi-khoa-bieu')
}

export async function deleteSubject(id: string) {
  const supabase = await createClient()
  const { error } = await supabase.from('subjects').delete().eq('id', id)
  if (error) throw new Error(error.message)
  revalidatePath('/thoi-khoa-bieu')
}
