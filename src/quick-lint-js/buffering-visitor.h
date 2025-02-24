// Copyright (C) 2020  Matthew "strager" Glazar
// See end of file for extended copyright information.

#ifndef QUICK_LINT_JS_BUFFERING_VISITOR_H
#define QUICK_LINT_JS_BUFFERING_VISITOR_H

#include <boost/container/pmr/memory_resource.hpp>
#include <boost/container/pmr/polymorphic_allocator.hpp>
#include <deque>
#include <optional>
#include <quick-lint-js/language.h>
#include <quick-lint-js/lex.h>
#include <quick-lint-js/parse-visitor.h>
#include <quick-lint-js/warning.h>
#include <utility>

QLJS_WARNING_PUSH
QLJS_WARNING_IGNORE_MSVC(26495)  // Variable is uninitialized.

namespace quick_lint_js {
class buffering_visitor final : public parse_visitor_base {
 public:
  explicit buffering_visitor(boost::container::pmr::memory_resource *memory)
      : visits_(memory) {}

  void move_into(parse_visitor_base &target);
  void copy_into(parse_visitor_base &target) const;

  void visit_end_of_module() override { this->add(visit_kind::end_of_module); }

  void visit_enter_block_scope() override {
    this->add(visit_kind::enter_block_scope);
  }

  void visit_enter_with_scope() override {
    this->add(visit_kind::enter_with_scope);
  }

  void visit_enter_class_scope() override {
    this->add(visit_kind::enter_class_scope);
  }

  void visit_enter_for_scope() override {
    this->add(visit_kind::enter_for_scope);
  }

  void visit_enter_function_scope() override {
    this->add(visit_kind::enter_function_scope);
  }

  void visit_enter_function_scope_body() override {
    this->add(visit_kind::enter_function_scope_body);
  }

  void visit_enter_named_function_scope(identifier name) override {
    this->add(name, visit_kind::enter_named_function_scope);
  }

  void visit_exit_block_scope() override {
    this->add(visit_kind::exit_block_scope);
  }

  void visit_exit_with_scope() override {
    this->add(visit_kind::exit_with_scope);
  }

  void visit_exit_class_scope() override {
    this->add(visit_kind::exit_class_scope);
  }

  void visit_exit_for_scope() override {
    this->add(visit_kind::exit_for_scope);
  }

  void visit_exit_function_scope() override {
    this->add(visit_kind::exit_function_scope);
  }

  void visit_keyword_variable_use(identifier name) override {
    this->add(name, visit_kind::keyword_variable_use);
  }

  void visit_property_declaration(std::optional<identifier> name) override {
    if (name.has_value()) {
      this->add(*name, visit_kind::property_declaration_with_name);
    } else {
      this->add(visit_kind::property_declaration_without_name);
    }
  }

  void visit_variable_assignment(identifier name) override {
    this->add(name, visit_kind::variable_assignment);
  }

  void visit_variable_declaration(identifier name, variable_kind kind,
                                  variable_init_kind init_kind) override {
    this->visits_.emplace_back(visit_kind::variable_declaration, name, kind,
                               init_kind);
  }

  void visit_variable_delete_use(identifier name,
                                 source_code_span delete_keyword) override {
    this->visits_.emplace_back(visit_kind::variable_delete_use, name,
                               delete_keyword);
  }

  void visit_variable_export_use(identifier name) override {
    this->add(name, visit_kind::variable_export_use);
  }

  void visit_variable_type_use(identifier name) override {
    this->add(name, visit_kind::variable_type_use);
  }

  void visit_variable_typeof_use(identifier name) override {
    this->add(name, visit_kind::variable_typeof_use);
  }

  void visit_variable_use(identifier name) override {
    this->add(name, visit_kind::variable_use);
  }

 private:
  enum class visit_kind {
    end_of_module,
    enter_block_scope,
    enter_with_scope,
    enter_class_scope,
    enter_for_scope,
    enter_function_scope,
    enter_function_scope_body,
    enter_named_function_scope,
    exit_block_scope,
    exit_with_scope,
    exit_class_scope,
    exit_for_scope,
    exit_function_scope,
    keyword_variable_use,
    property_declaration_with_name,
    property_declaration_without_name,
    variable_assignment,
    variable_delete_use,
    variable_export_use,
    variable_type_use,
    variable_typeof_use,
    variable_use,
    variable_declaration,
  };

  // These 'add' functions significantly reduces code size by discouraging the
  // inlining of visit::visit and std::deque<>::emplace_back.
  [[gnu::noinline]] void add(visit_kind kind) {
    this->visits_.emplace_back(kind);
  }

  [[gnu::noinline]] void add(const identifier &name, visit_kind kind) {
    this->visits_.emplace_back(kind, name);
  }

  struct visit {
    explicit visit(visit_kind kind) noexcept : kind(kind) {}

    explicit visit(visit_kind kind, identifier name) noexcept
        : kind(kind), name(name) {}

    explicit visit(visit_kind kind, identifier name, variable_kind var_kind,
                   variable_init_kind init_kind) noexcept
        : kind(kind), name(name), var_decl{var_kind, init_kind} {}

    explicit visit(visit_kind kind, identifier name,
                   source_code_span extra_span) noexcept
        : kind(kind), name(name), extra_span(extra_span) {}

    visit_kind kind;

    union {
      // enter_named_function_scope, keyword_variable_use, property_declaration,
      // variable_assignment, variable_declaration, variable_use
      identifier name;
      static_assert(std::is_trivially_destructible_v<identifier>);
    };

    struct var_decl_data {
      variable_kind var_kind;
      variable_init_kind var_init_kind;
    };
    union {
      // variable_declaration
      var_decl_data var_decl;
      static_assert(std::is_trivially_destructible_v<var_decl_data>);

      // variable_delete_use
      source_code_span extra_span;
      static_assert(std::is_trivially_destructible_v<source_code_span>);
    };
  };

  std::deque<visit, boost::container::pmr::polymorphic_allocator<visit>>
      visits_;
};
}

QLJS_WARNING_POP

#endif

// quick-lint-js finds bugs in JavaScript programs.
// Copyright (C) 2020  Matthew "strager" Glazar
//
// This file is part of quick-lint-js.
//
// quick-lint-js is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// quick-lint-js is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.
//
// You should have received a copy of the GNU General Public License
// along with quick-lint-js.  If not, see <https://www.gnu.org/licenses/>.
