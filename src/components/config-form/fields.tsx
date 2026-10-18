'use client';

import React, { useState } from 'react';
import { Controller, useFormContext, type FieldError as FormFieldError, type FieldPath } from 'react-hook-form';
import { Eye, EyeOff } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { Config } from '@/lib/types';
import { Field, FieldContent, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from '@/components/ui/input-group';
import { NativeSelect } from '@/components/ui/native-select';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';

// Field components of the config form: shadcn Field around react-hook-form's Controller, bound to the form in
// context (FormProvider). Each one renders its label, control, hint and inline error, and ties them together
// (htmlFor/id, aria-invalid, aria-describedby). Names are paths into the Config.
//
// A cleared input holds null, not undefined: react-hook-form shows a field's default value again when it holds
// undefined. Payload and validation drop nulls (withoutClearedFields in lib/config/form.ts).

export type ConfigFieldName = FieldPath<Config>;

function fieldId(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]/g, '-');
}

interface AriaProps {
  id: string;
  'aria-invalid'?: true;
  'aria-describedby'?: string;
}

interface FrameProps {
  id: string;
  label: React.ReactNode;
  description?: React.ReactNode;
  aside?: React.ReactNode;             // Between the control and its hint
  footer?: React.ReactNode;            // Extra notes below the hint
  error?: FormFieldError;
  className?: string;
  children: (aria: AriaProps) => React.ReactNode;
}

// Label, control, hint and error of a stacked field
function FieldFrame({ id, label, description, aside, footer, error, className, children }: FrameProps) {
  const invalid = !!error;
  const aria: AriaProps = {
    id,
    'aria-invalid': invalid || undefined,
    'aria-describedby': [description ? `${id}-description` : '', invalid ? `${id}-error` : ''].filter(Boolean).join(' ') || undefined,
  };
  return (
    <Field data-invalid={invalid} className={cn('gap-2', className)}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      {children(aria)}
      {aside}
      {description && <FieldDescription id={`${id}-description`} className="text-xs">{description}</FieldDescription>}
      {footer}
      <FieldError id={`${id}-error`} errors={[error]} />
    </Field>
  );
}

interface BaseFieldProps {
  name: ConfigFieldName;
  label: React.ReactNode;
  description?: React.ReactNode;
  footer?: React.ReactNode;
  id?: string;                          // Defaults to the name
  className?: string;                   // On the field, around label, control and hint
  deps?: ConfigFieldName[];             // Fields to validate again when this one changes
}

// A label above its control (every field but the switch)
interface StackedFieldProps extends BaseFieldProps {
  aside?: React.ReactNode;              // Between the control and its hint
}

// ----- Text -----

type InputProps = Omit<React.ComponentProps<'input'>, 'name' | 'value' | 'onChange' | 'id' | 'type' | 'className'>;

interface TextFieldProps extends StackedFieldProps, InputProps {
  inputClassName?: string;              // On the control itself
  type?: 'text' | 'password';
  parse?: (text: string) => unknown;    // Typed text -> stored value (default: the text)
  reveal?: string;                      // Password input with a show/hide button naming this ("API private key")
}

export function TextField({ name, label, description, aside, footer, id: idProp, className, inputClassName, deps, type = 'text', parse, reveal, ...inputProps }: TextFieldProps) {
  const { control } = useFormContext<Config>();
  const id = idProp ?? fieldId(name);
  return (
    <Controller
      name={name}
      control={control}
      rules={deps ? { deps } : undefined}
      render={({ field, fieldState }) => (
        <FieldFrame id={id} label={label} description={description} aside={aside} footer={footer} error={fieldState.error} className={className}>
          {(aria) => {
            const props = {
              ...inputProps,
              ...aria,
              className: inputClassName,
              name: field.name,
              ref: field.ref,
              onBlur: field.onBlur,
              value: typeof field.value === 'string' ? field.value : '',
              onChange: (e: React.ChangeEvent<HTMLInputElement>) => field.onChange(parse ? parse(e.target.value) : e.target.value),
            };
            return reveal ? <SecretInput props={props} reveal={reveal} /> : <Input {...props} type={type} />;
          }}
        </FieldFrame>
      )}
    />
  );
}

// Password input that can be shown while typing
function SecretInput({ props, reveal }: { props: React.ComponentProps<'input'>; reveal: string }) {
  const [shown, setShown] = useState(false);
  return (
    <InputGroup>
      <InputGroupInput {...props} type={shown ? 'text' : 'password'} />
      <InputGroupAddon align="inline-end">
        <InputGroupButton size="icon-xs" aria-label={`${shown ? 'Hide' : 'Show'} ${reveal}`} onClick={() => setShown(!shown)}>
          {shown ? <EyeOff /> : <Eye />}
        </InputGroupButton>
      </InputGroupAddon>
    </InputGroup>
  );
}

// ----- Numbers -----

interface NumberFieldProps extends StackedFieldProps, InputProps {
  inputClassName?: string;              // On the control itself
  integer?: boolean;                    // Whole numbers only: what is typed after the point is dropped
  scale?: number;                       // Stored value = typed number x scale (seconds -> milliseconds)
  clamp?: (value: number) => number;
  parse?: (text: string) => unknown;    // Replaces the default number parsing
  suffix?: React.ReactNode;             // Text next to a short input instead of a full-width one
}

function parseNumber(text: string, integer: boolean): number | null {
  const value = integer ? parseInt(text, 10) : parseFloat(text);
  return Number.isNaN(value) ? null : value;
}

export function NumberField({
  name, label, description, aside, footer, id: idProp, className, inputClassName, deps, integer = false, scale = 1, clamp, parse, suffix, ...inputProps
}: NumberFieldProps) {
  const { control } = useFormContext<Config>();
  const id = idProp ?? fieldId(name);
  return (
    <Controller
      name={name}
      control={control}
      rules={deps ? { deps } : undefined}
      render={({ field, fieldState }) => (
        <FieldFrame id={id} label={label} description={description} aside={aside} footer={footer} error={fieldState.error} className={className}>
          {(aria) => {
            const stored: unknown = field.value;
            const shown = typeof stored === 'number' ? stored / scale : typeof stored === 'string' ? stored : '';
            const input = (
              <Input
                {...inputProps}
                {...aria}
                className={inputClassName}
                type="number"
                name={field.name}
                ref={field.ref}
                onBlur={(e) => {
                  field.onBlur();
                  inputProps.onBlur?.(e);
                }}
                value={shown}
                onChange={(e) => {
                  if (parse) return field.onChange(parse(e.target.value));
                  const value = parseNumber(e.target.value, integer);
                  field.onChange(value === null ? null : (clamp ? clamp(value) : value) * scale);
                }}
              />
            );
            return suffix ? (
              <div className="flex items-center gap-4">
                {input}
                <span className="text-sm text-muted-foreground">{suffix}</span>
              </div>
            ) : input;
          }}
        </FieldFrame>
      )}
    />
  );
}

// ----- Switch -----

interface SwitchFieldProps extends BaseFieldProps {
  icon?: React.ReactNode;               // Before the label
  badge?: React.ReactNode;              // After the label
  descriptionClassName?: string;
  inline?: boolean;                     // The switch before its label, the hint below, instead of label and hint on the left
  onCheckedChange?: (checked: boolean) => void;   // After the form value is set
}

// Label and hint on the left, the switch on the right
export function SwitchField({ name, label, description, footer, id: idProp, className, deps, icon, badge, descriptionClassName, inline, onCheckedChange }: SwitchFieldProps) {
  const { control } = useFormContext<Config>();
  const id = idProp ?? fieldId(name);
  return (
    <Controller
      name={name}
      control={control}
      rules={deps ? { deps } : undefined}
      render={({ field, fieldState }) => {
        const toggle = (
          <Switch
            id={id}
            ref={field.ref}
            checked={field.value === true}
            onBlur={field.onBlur}
            onCheckedChange={(checked) => {
              field.onChange(checked);
              onCheckedChange?.(checked);
            }}
            aria-invalid={fieldState.invalid || undefined}
            aria-describedby={description ? `${id}-description` : undefined}
          />
        );
        const hint = description && (
          <FieldDescription id={`${id}-description`} className={descriptionClassName}>{description}</FieldDescription>
        );
        const error = <FieldError id={`${id}-error`} errors={[fieldState.error]} />;
        if (inline) {
          return (
            <div className={cn('flex flex-col gap-4', className)}>
              <Field orientation="horizontal" data-invalid={!!fieldState.error} className="gap-2">
                {toggle}
                <FieldLabel htmlFor={id} className="cursor-pointer">{label}</FieldLabel>
              </Field>
              {hint}
              {footer}
              {error}
            </div>
          );
        }
        return (
          <Field orientation="horizontal" data-invalid={!!fieldState.error} className={cn('has-[>[data-slot=field-content]]:items-center', className)}>
            <FieldContent>
              <div className="flex items-center gap-2">
                {icon}
                <FieldLabel htmlFor={id}>{label}</FieldLabel>
                {badge}
              </div>
              {hint}
              {footer}
              {error}
            </FieldContent>
            {toggle}
          </Field>
        );
      }}
    />
  );
}

// ----- Selects -----

interface SelectFieldProps extends StackedFieldProps {
  options: { value: string; label: React.ReactNode }[];
  fallback?: string;                    // Shown while the field has no value
  onValueChange?: (value: string) => void;
}

export function SelectField({ name, label, description, aside, footer, id: idProp, className, deps, options, fallback, onValueChange }: SelectFieldProps) {
  const { control } = useFormContext<Config>();
  const id = idProp ?? fieldId(name);
  return (
    <Controller
      name={name}
      control={control}
      rules={deps ? { deps } : undefined}
      render={({ field, fieldState }) => (
        <FieldFrame id={id} label={label} description={description} aside={aside} footer={footer} error={fieldState.error} className={className}>
          {(aria) => (
            <Select
              value={typeof field.value === 'string' ? field.value : fallback}
              onValueChange={(value) => {
                field.onChange(value);
                onValueChange?.(value);
              }}
            >
              <SelectTrigger {...aria} ref={field.ref} onBlur={field.onBlur}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {options.map((option) => (
                  <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </FieldFrame>
      )}
    />
  );
}

interface NativeSelectFieldProps extends StackedFieldProps {
  fallback?: string;                    // Shown while the field has no value
  onValueChange?: (value: string) => boolean | void;   // Return false to refuse the choice
  children: React.ReactNode;            // <option>s
}

// A native <select>: the long option texts of these fields do not fit a popover, and options can be disabled
// with a reason in their text
export function NativeSelectField({ name, label, description, aside, footer, id: idProp, className, deps, fallback, onValueChange, children }: NativeSelectFieldProps) {
  const { control } = useFormContext<Config>();
  const id = idProp ?? fieldId(name);
  return (
    <Controller
      name={name}
      control={control}
      rules={deps ? { deps } : undefined}
      render={({ field, fieldState }) => (
        <FieldFrame id={id} label={label} description={description} aside={aside} footer={footer} error={fieldState.error} className={className}>
          {(aria) => (
            <NativeSelect
              {...aria}
              name={field.name}
              ref={field.ref}
              onBlur={field.onBlur}
              value={typeof field.value === 'string' ? field.value : fallback}
              onChange={(e) => {
                if (onValueChange?.(e.target.value) === false) return;
                field.onChange(e.target.value);
              }}
            >
              {children}
            </NativeSelect>
          )}
        </FieldFrame>
      )}
    />
  );
}
