"use client"

import * as React from "react"
import { CalendarDaysIcon, XIcon } from "lucide-react"
import type { DateRange } from "react-day-picker"

import { Button } from "@/components/ui/button"
import { Calendar } from "@/components/ui/calendar"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { cn } from "@/lib/utils"

export type DateRangeValue = { start: string; end: string }

type DatePickerProps = {
  value: string
  onChange: (value: string) => void
  label?: string
  placeholder?: string
  disabled?: boolean
  clearable?: boolean
  className?: string
}

type DateRangePickerProps = {
  value: DateRangeValue
  onChange: (value: DateRangeValue) => void
  label?: string
  placeholder?: string
  disabled?: boolean
  className?: string
}

const calendarStart = new Date(2020, 0, 1)
const calendarEnd = new Date(new Date().getFullYear() + 5, 11, 31)

function DatePicker({
  value,
  onChange,
  label = "Date",
  placeholder = "Choose date",
  disabled = false,
  clearable = false,
  className,
}: DatePickerProps) {
  const [open, setOpen] = React.useState(false)
  const selected = parseLocalDate(value)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          disabled={disabled}
          aria-label={`${label}: ${selected ? formatPickerDate(selected) : "not selected"}`}
          className={cn(
            "h-10 w-full justify-start gap-2 bg-background px-3 text-left font-normal",
            !selected && "text-muted-foreground",
            className
          )}
        >
          <CalendarDaysIcon aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate">
            {selected ? formatPickerDate(selected) : placeholder}
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-auto gap-0 p-0">
        <Calendar
          mode="single"
          selected={selected}
          defaultMonth={selected}
          onSelect={(date) => {
            if (!date) return
            onChange(toLocalDateValue(date))
            setOpen(false)
          }}
          captionLayout="dropdown"
          navLayout="after"
          startMonth={calendarStart}
          endMonth={calendarEnd}
          autoFocus
        />
        <div className="flex items-center justify-between gap-2 border-t p-2">
          <Button
            type="button"
            size="sm"
            variant="secondary"
            onClick={() => {
              onChange(toLocalDateValue(new Date()))
              setOpen(false)
            }}
          >
            Today
          </Button>
          {clearable && value && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => {
                onChange("")
                setOpen(false)
              }}
            >
              <XIcon aria-hidden="true" />
              Clear
            </Button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}

function DateRangePicker({
  value,
  onChange,
  label = "Date range",
  placeholder = "All dates",
  disabled = false,
  className,
}: DateRangePickerProps) {
  const [open, setOpen] = React.useState(false)
  const selected: DateRange | undefined = value.start || value.end
    ? { from: parseLocalDate(value.start), to: parseLocalDate(value.end) }
    : undefined
  const summary = formatRange(value, placeholder)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          disabled={disabled}
          aria-label={`${label}: ${summary}`}
          className={cn(
            "h-10 w-full justify-start gap-2 bg-background px-3 text-left font-normal",
            !value.start && !value.end && "text-muted-foreground",
            className
          )}
        >
          <CalendarDaysIcon aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate">{summary}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-auto max-w-[calc(100vw-2rem)] gap-0 overflow-auto p-0">
        <Calendar
          mode="range"
          selected={selected}
          defaultMonth={selected?.from ?? selected?.to}
          onSelect={(range) => onChange({
            start: range?.from ? toLocalDateValue(range.from) : "",
            end: range?.to ? toLocalDateValue(range.to) : "",
          })}
          captionLayout="dropdown"
          navLayout="after"
          numberOfMonths={2}
          pagedNavigation
          startMonth={calendarStart}
          endMonth={calendarEnd}
          autoFocus
        />
        <div className="flex flex-wrap items-center justify-between gap-2 border-t p-2">
          <Button type="button" size="sm" variant="ghost" onClick={() => onChange({ start: "", end: "" })}>
            <XIcon aria-hidden="true" />
            Clear range
          </Button>
          <Button type="button" size="sm" onClick={() => setOpen(false)} disabled={!value.start && !value.end}>
            Apply range
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}

function parseLocalDate(value: string): Date | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return undefined
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  return Number.isNaN(date.getTime()) ? undefined : date
}

function toLocalDateValue(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, "0")
  const day = String(date.getDate()).padStart(2, "0")
  return `${year}-${month}-${day}`
}

function formatPickerDate(date: Date): string {
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(date)
}

function formatRange(value: DateRangeValue, placeholder: string): string {
  const start = parseLocalDate(value.start)
  const end = parseLocalDate(value.end)
  if (start && end) return `${formatPickerDate(start)} - ${formatPickerDate(end)}`
  if (start) return `From ${formatPickerDate(start)}`
  if (end) return `Through ${formatPickerDate(end)}`
  return placeholder
}

export { DatePicker, DateRangePicker }
