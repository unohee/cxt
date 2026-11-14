[
  (function_declaration)
  (generator_function_declaration)
  (class_declaration)
  (method_definition)
  (variable_declarator)
  (field_definition)
] @declaration

(export_statement value: (function_expression) @declaration)
(export_statement value: (arrow_function) @declaration)
(export_statement value: (class) @declaration)
