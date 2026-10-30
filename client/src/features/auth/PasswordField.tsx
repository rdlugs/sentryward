import { useState, type ComponentProps, type ReactNode } from "react"
import { Eye, EyeOff, Lock } from "lucide-react"
import { Controller, type Control, type FieldValues, type Path } from "react-hook-form"
import { Field, FieldError, FieldLabel } from "@/components/ui/field"
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group"

type PasswordFieldProps<T extends FieldValues> = {
  control: Control<T>
  name: Path<T>
  label: string
  /** Rendered under the input, above any error (e.g. a strength hint). */
  children?: ReactNode
} & Omit<ComponentProps<typeof InputGroupInput>, "name" | "id" | "type">

export function PasswordField<T extends FieldValues>({
  control,
  name,
  label,
  children,
  ...inputProps
}: PasswordFieldProps<T>) {
  const [visible, setVisible] = useState(false)
  const ToggleIcon = visible ? EyeOff : Eye

  return (
    <Controller
      control={control}
      name={name}
      render={({ field, fieldState }) => (
        <Field data-invalid={fieldState.invalid}>
          <FieldLabel htmlFor={name}>{label}</FieldLabel>
          <InputGroup>
            <InputGroupInput
              {...inputProps}
              {...field}
              id={name}
              type={visible ? "text" : "password"}
              aria-invalid={fieldState.invalid}
            />
            <InputGroupAddon>
              <Lock />
            </InputGroupAddon>
            <InputGroupAddon align="inline-end">
              <InputGroupButton
                size="icon-xs"
                aria-label={visible ? "Hide password" : "Show password"}
                aria-pressed={visible}
                onClick={() => setVisible((v) => !v)}
              >
                <ToggleIcon />
              </InputGroupButton>
            </InputGroupAddon>
          </InputGroup>
          {children}
          {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
        </Field>
      )}
    />
  )
}
