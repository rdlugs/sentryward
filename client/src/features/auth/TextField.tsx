import type { ComponentProps } from "react"
import type { LucideIcon } from "lucide-react"
import { Controller, type Control, type FieldValues, type Path } from "react-hook-form"
import { Field, FieldError, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group"

type TextFieldProps<T extends FieldValues> = {
  control: Control<T>
  name: Path<T>
  label: string
  icon?: LucideIcon
} & Omit<ComponentProps<typeof Input>, "name" | "id">

export function TextField<T extends FieldValues>({
  control,
  name,
  label,
  icon: Icon,
  ...inputProps
}: TextFieldProps<T>) {
  return (
    <Controller
      control={control}
      name={name}
      render={({ field, fieldState }) => (
        <Field data-invalid={fieldState.invalid}>
          <FieldLabel htmlFor={name}>{label}</FieldLabel>
          {Icon ? (
            <InputGroup>
              <InputGroupInput {...inputProps} {...field} id={name} aria-invalid={fieldState.invalid} />
              <InputGroupAddon>
                <Icon />
              </InputGroupAddon>
            </InputGroup>
          ) : (
            <Input {...inputProps} {...field} id={name} aria-invalid={fieldState.invalid} />
          )}
          {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
        </Field>
      )}
    />
  )
}
